import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Machine, createDefaultBehavior, validateBehavior, type BehaviorKind, type Config, type Scenario } from './machine';

const configUrl = new URL('../machines.json', import.meta.url);
const configs: Config[] = JSON.parse(await readFile(configUrl, 'utf8'));
const manufacturerOf = (c: Config) => c.manufacturer || (c.template === 'delta-dvp' ? 'delta' : c.template === 'mitsubishi-fx5' ? 'mitsubishi' : 'generic');
const validConfig = (c: Config) => /^[a-z0-9_-]+$/i.test(c.id) && typeof c.name === 'string' && c.name.trim().length > 0 && c.name.length <= 80 && Number.isInteger(c.port) && c.port >= 1024 && c.port <= 65535 && Number.isInteger(c.unitId) && c.unitId >= 1 && c.unitId <= 247 && ['generic', 'delta', 'mitsubishi'].includes(manufacturerOf(c)) && (c.model || 'generic') === 'generic' && (!c.behaviors || c.behaviors.every(validateBehavior));
if (!Array.isArray(configs) || !configs.length || configs.some(c => !validConfig(c)) || new Set(configs.map(c => c.port)).size !== configs.length || new Set(configs.map(c => c.id)).size !== configs.length) throw new Error('machines.json inválido');
const host = process.env.MODBUS_HOST || '127.0.0.1';
const execFileAsync = promisify(execFile);
async function ensureWindowsFirewallPort(port: number) {
  if (process.platform !== 'win32') throw new Error('A liberação automática de firewall está disponível somente no Windows.');
  const ruleName = `CLP Simulator Modbus ${port}`;
  const escapedName = ruleName.replace(/'/g, "''");
  const script = `$rule=Get-NetFirewallRule -DisplayName '${escapedName}' -ErrorAction SilentlyContinue;if($rule){Write-Output 'existing';exit 0};$args='advfirewall firewall add rule name="${ruleName}" dir=in action=allow protocol=TCP localport=${port}';$p=Start-Process -FilePath netsh.exe -ArgumentList $args -Verb RunAs -Wait -PassThru;if($p.ExitCode -ne 0){exit $p.ExitCode};Write-Output 'created'`;
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 120000, windowsHide: true });
  return stdout.includes('existing') ? 'existing' : 'created';
}
const machines = configs.map(c => new Machine(c));
const saveConfigs = () => writeFile(configUrl, JSON.stringify(machines.map(m => m.config), null, 2) + '\n', 'utf8');
const app = express();
app.use(express.json({ limit: '8kb' }));
app.get('/api/machines', (_req, res) => res.json(machines.map(m => m.snapshot())));
app.post('/api/machines', async (req, res) => {
  const config: Config = { id: String(req.body?.id || '').trim(), name: String(req.body?.name || '').trim(), port: Number(req.body?.port), unitId: Number(req.body?.unitId), manufacturer: req.body?.manufacturer || 'generic', model: req.body?.model || 'generic', behaviors: [] };
  if (!validConfig(config)) { res.status(400).json({ error: 'Cadastro inválido. Revise nome, ID, porta (1024–65535), Unit ID (1–247), fabricante e modelo.' }); return; }
  if (machines.some(m => m.config.id === config.id)) { res.status(409).json({ error: 'Já existe uma CLP com esse ID.' }); return; }
  if (machines.some(m => m.config.port === config.port)) { res.status(409).json({ error: 'Essa porta já está sendo usada por outra CLP.' }); return; }
  const machine = new Machine(config);
  machines.push(machine);
  bindMachine(machine);
  try { await saveConfigs(); await machine.start(host); broadcast({ type: 'machine.created', machine: machine.snapshot() }); res.status(201).json(machine.snapshot()); }
  catch (error) { machine.log(`Falha ao iniciar: ${(error as Error).message}`); res.status(201).json(machine.snapshot()); }
});
app.delete('/api/machines/:id', async (req, res) => {
  const index = machines.findIndex(m => m.config.id === req.params.id);
  if (index < 0) { res.status(404).json({ error: 'Máquina não encontrada' }); return; }
  if (machines.length === 1) { res.status(400).json({ error: 'Mantenha ao menos uma CLP cadastrada.' }); return; }
  const [machine] = machines.splice(index, 1);
  await machine.stop(); await saveConfigs(); broadcast({ type: 'machine.deleted', machineId: machine.config.id }); res.status(204).end();
});
const locks = new Map<string, Promise<unknown>>();
app.post('/api/machines/:id', async (req, res) => {
  const machine = machines.find(m => m.config.id === req.params.id);
  if (!machine) { res.status(404).json({ error: 'Máquina não encontrada' }); return; }
  const operation = (locks.get(machine.config.id) ?? Promise.resolve()).then(async () => {
    const b = req.body;
    if (!b || typeof b !== 'object') throw new Error('Comando inválido');
    switch (b.action) {
      case 'start': await machine.start(host); break;
      case 'stop': await machine.stop(); break;
      case 'restart': await machine.stop(); machine.reset(); await machine.start(host); break;
      case 'reset': machine.reset(); break;
      case 'clear-registers': machine.clearRegisters(); break;
      case 'settings':
        if (typeof b.silent !== 'boolean' || !Number.isInteger(b.latencyMs) || b.latencyMs < 0 || b.latencyMs > 10000 || !Number.isInteger(b.pollIntervalMs) || b.pollIntervalMs < 200 || b.pollIntervalMs > 60000 || typeof b.pollingEnabled !== 'boolean' || !['AB', 'BA'].includes(b.byteOrder)) throw new Error('Parâmetros inválidos');
        Object.assign(machine, { silent: b.silent, latencyMs: b.latencyMs, pollIntervalMs: b.pollIntervalMs, pollingEnabled: b.pollingEnabled, byteOrder: b.byteOrder }); machine.log('SYS Configuração de simulação atualizada'); break;
      case 'memory':
        if (!Number.isInteger(b.address) || b.address < 0 || !['coil', 'register'].includes(b.area)) throw new Error('Endereço inválido');
        if (b.area === 'coil') { if (b.address >= machine.coils.length || ![0, 1].includes(b.value)) throw new Error('Coil inválido'); machine.coils[b.address] = Boolean(b.value); }
        else { if (b.address >= machine.registers.length || !Number.isInteger(b.value) || b.value < 0 || b.value > 65535) throw new Error('Registro inválido'); machine.registers[b.address] = b.value; }
        machine.log(`Memória manual: ${b.area} ${b.address} = ${b.value}`); break;
      case 'memory-bulk': {
        if (!Number.isInteger(b.address) || b.address < 0 || b.address >= machine.registers.length || !Array.isArray(b.values) || !b.values.length || b.address + b.values.length > machine.registers.length || b.values.some((v: unknown) => !Number.isInteger(v) || Number(v) < 0 || Number(v) > 65535)) throw new Error('Faixa de registradores inválida');
        machine.write(b.address, b.values); machine.log(`SYS Escrita manual: registros ${b.address}–${b.address + b.values.length - 1}`); break;
      }
      case 'template':
        if (!['generic', 'delta', 'mitsubishi'].includes(b.manufacturer) || b.model !== 'generic') throw new Error('Fabricante ou modelo inválido');
        machine.manufacturer = b.manufacturer; machine.model = b.model; machine.config.manufacturer = b.manufacturer; machine.config.model = b.model; machine.log(`SYS Template aplicado: ${b.manufacturer}/${b.model}`); await saveConfigs(); break;
      case 'rename':
        if (typeof b.name !== 'string' || !b.name.trim() || b.name.trim().length > 80) throw new Error('Nome da estação inválido');
        machine.config.name = b.name.trim(); machine.log(`SYS Estação renomeada para ${machine.config.name}`); await saveConfigs(); break;
      case 'faults':
        if (['packetLossPercent', 'disconnectPercent', 'corruptReadPercent'].some(key => typeof b[key] !== 'number' || b[key] < 0 || b[key] > 100)) throw new Error('Percentual de falha inválido');
        machine.faults = { packetLossPercent: b.packetLossPercent, disconnectPercent: b.disconnectPercent, corruptReadPercent: b.corruptReadPercent }; machine.config.faults = machine.faults; machine.log('SYS Perfil de injeção de falhas atualizado'); await saveConfigs(); break;
      case 'behavior-create': {
        const kinds: BehaviorKind[] = ['digital-io', 'analog-process', 'state-machine', 'handshake', 'counter', 'alarm', 'heartbeat'];
        if (!kinds.includes(b.kind)) throw new Error('Tipo de comportamento inválido');
        let id = `${b.kind}_${Date.now().toString(36)}`, suffix = 1;
        while (machine.behaviors.some(item => item.id === id)) id = `${b.kind}_${Date.now().toString(36)}_${suffix++}`;
        machine.configureBehavior(createDefaultBehavior(b.kind, id)); await saveConfigs(); break;
      }
      case 'behavior-save':
        if (!validateBehavior(b.behavior)) throw new Error('Configuração de comportamento inválida');
        if (!machine.behaviors.some(item => item.id === b.behavior.id)) throw new Error('Comportamento não encontrado');
        machine.configureBehavior(b.behavior); await saveConfigs(); break;
      case 'behavior-delete':
        machine.removeBehavior(String(b.id || '')); await saveConfigs(); break;
      case 'scenario-save': {
        const scenario: Scenario = { id: String(b.id || '').trim(), name: String(b.name || '').trim(), enabled: Boolean(b.enabled), trigger: b.trigger, intervalMs: Number(b.intervalMs), conditionAddress: Number(b.conditionAddress), conditionValue: Number(b.conditionValue), targetArea: b.targetArea, targetAddress: Number(b.targetAddress), targetValue: Number(b.targetValue), lastRunAt: Number(b.lastRunAt || 0) };
        if (!/^[a-z0-9_-]+$/i.test(scenario.id) || !scenario.name || !['interval', 'register', 'coil'].includes(scenario.trigger) || !['register', 'coil'].includes(scenario.targetArea) || !Number.isInteger(scenario.intervalMs) || scenario.intervalMs < 250 || scenario.intervalMs > 86400000 || !Number.isInteger(scenario.conditionAddress) || scenario.conditionAddress < 0 || !Number.isInteger(scenario.conditionValue) || !Number.isInteger(scenario.targetAddress) || scenario.targetAddress < 0 || !Number.isInteger(scenario.targetValue) || scenario.targetValue < 0 || scenario.targetValue > (scenario.targetArea === 'coil' ? 1 : 65535)) throw new Error('Cenário inválido');
        if (scenario.targetAddress >= (scenario.targetArea === 'coil' ? machine.coils.length : machine.registers.length)) throw new Error('Destino do cenário fora do mapa');
        machine.configureScenario(scenario); await saveConfigs(); break;
      }
      case 'scenario-delete': machine.removeScenario(String(b.id)); await saveConfigs(); break;
      case 'scenario-run': { const scenario = machine.scenarios.find(item => item.id === b.id); if (!scenario) throw new Error('Cenário não encontrado'); machine.runScenario(scenario); break; }
      case 'clear-history': machine.history.length = 0; machine.log('SYS Histórico limpo pelo operador'); break;
      case 'clear-logs': machine.logs.length = 0; machine.log('SYS Log limpo pelo operador'); break;
      case 'diagnostic':
        if (!machine.online) throw new Error('Conecte o listener antes de executar o autoteste');
        await machine.runDiagnostic(); break;
      case 'firewall-open': {
        const result = await ensureWindowsFirewallPort(machine.config.port);
        machine.log(`SYS Firewall do Windows: regra ${result === 'created' ? 'criada' : 'já existente'} para TCP ${machine.config.port}`);
        break;
      }
      default: throw new Error('Ação desconhecida');
    }
  });
  locks.set(machine.config.id, operation.catch(() => {}));
  try {
    await operation;
    const snapshot = machine.snapshot();
    broadcast({ type: 'machine.updated', machine: snapshot });
    res.json(snapshot);
  } catch (error) { res.status(400).json({ error: (error as Error).message }); }
});
app.use(express.static(fileURLToPath(new URL('../dist/', import.meta.url))));
app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status || 500).json({ error: error.message }));
const server = app.listen(Number(process.env.PORT || 3100), '127.0.0.1', () => console.log('Painel: http://127.0.0.1:' + (process.env.PORT || 3100)));
const wss = new WebSocketServer({ server, path: '/ws' });
function send(socket: WebSocket, message: object) { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); }
function broadcast(message: object) { for (const socket of wss.clients) send(socket, message); }
function bindMachine(machine: Machine) { machine.setEventSink(event => event.type === 'refresh' ? broadcast({ type: 'machine.updated', machine: machine.snapshot() }) : broadcast({ type: `machine.${event.type}`, machineId: machine.config.id, ...event.payload })); }
for (const machine of machines) bindMachine(machine);
wss.on('connection', socket => {
  const client = socket as WebSocket & { isAlive?: boolean }; client.isAlive = true;
  client.on('pong', () => { client.isAlive = true; });
  send(client, { type: 'snapshot', machines: machines.map(machine => machine.snapshot()) });
});
const heartbeat = setInterval(() => { for (const socket of wss.clients) { const client = socket as WebSocket & { isAlive?: boolean }; if (client.isAlive === false) { client.terminate(); continue; } client.isAlive = false; client.ping(); } }, 15000);
for (const machine of machines) { try { await machine.start(host); } catch (error) { machine.log(`Falha ao iniciar: ${(error as Error).message}`); } }
async function shutdown() { clearInterval(heartbeat); wss.close(); server.close(); await Promise.all(machines.map(m => m.stop())); }
server.on('error', error => { console.error(error.message); void shutdown(); process.exitCode = 1; });
process.once('SIGINT', () => void shutdown()); process.once('SIGTERM', () => void shutdown());
