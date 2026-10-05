import ModbusRTU, { ServerTCP } from 'modbus-serial';
import { networkInterfaces } from 'node:os';
import type { Server as NetServer, Socket } from 'node:net';

export type MachineManufacturer = 'generic' | 'delta' | 'mitsubishi';
export type MachineModel = 'generic';
export type LegacyMachineTemplate = 'generic' | 'delta-dvp' | 'mitsubishi-fx5';
export type FaultConfig = { packetLossPercent: number; disconnectPercent: number; corruptReadPercent: number };
export type BehaviorKind = 'digital-io' | 'analog-process' | 'state-machine' | 'handshake' | 'counter' | 'alarm' | 'heartbeat';
export type Behavior =
  | { id: string; name: string; kind: 'digital-io'; enabled: boolean; config: { address: number; onMs: number; offMs: number } }
  | { id: string; name: string; kind: 'analog-process'; enabled: boolean; config: { address: number; waveform: 'ramp' | 'sine' | 'random'; min: number; max: number; periodMs: number } }
  | { id: string; name: string; kind: 'state-machine'; enabled: boolean; config: { commandCoil: number; faultCoil: number; stateRegister: number; startMs: number; stopMs: number } }
  | { id: string; name: string; kind: 'handshake'; enabled: boolean; config: { requestCoil: number; busyCoil: number; doneCoil: number; ackCoil: number; errorCoil: number; cycleMs: number } }
  | { id: string; name: string; kind: 'counter'; enabled: boolean; config: { sourceCoil: number; resetCoil: number; targetRegister: number; step: number; max: number } }
  | { id: string; name: string; kind: 'alarm'; enabled: boolean; config: { sourceRegister: number; alarmCoil: number; ackCoil: number; low: number; high: number; latched: boolean } }
  | { id: string; name: string; kind: 'heartbeat'; enabled: boolean; config: { register: number; healthyCoil: number; intervalMs: number; max: number } };
export type Scenario = { id: string; name: string; enabled: boolean; trigger: 'interval' | 'register' | 'coil'; intervalMs: number; conditionAddress: number; conditionValue: number; targetArea: 'register' | 'coil'; targetAddress: number; targetValue: number; lastRunAt: number };
export type HistoryPoint = { time: string; register0: number; register1: number; register2: number; deltaD0: number; coil0: number; coil1: number; rx: number; tx: number };
export type ClientConnection = { id: string; address: string; port: number; connectedAt: string; lastActivityAt: string; requests: number; bytesReceived: number; bytesSent: number };
export type NetworkEndpoint = { address: string; interfaceName: string; kind: 'physical' | 'virtual' | 'unknown' };
export type DiagnosticCheck = { id: string; label: string; ok: boolean; durationMs: number; detail: string };
export type DiagnosticResult = { status: 'passed' | 'failed'; startedAt: string; finishedAt: string; durationMs: number; target: string; registerAddress: number; coilAddress: number; checks: DiagnosticCheck[]; error?: string };
export type MachineEvent = { type: 'log' | 'traffic' | 'memory' | 'history' | 'status' | 'clients' | 'refresh'; payload: Record<string, unknown> };
export type Config = { id: string; name: string; port: number; unitId: number; manufacturer?: MachineManufacturer; model?: MachineModel; template?: LegacyMachineTemplate; faults?: FaultConfig; scenarios?: Scenario[]; behaviors?: Behavior[] };
export type ByteOrder = 'AB' | 'BA';

const behaviorNames: Record<BehaviorKind, string> = { 'digital-io': 'Entrada e saída digital', 'analog-process': 'Processo analógico', 'state-machine': 'Máquina de estados', handshake: 'Ciclo e handshake', counter: 'Contador e encoder', alarm: 'Alarmes e intertravamentos', heartbeat: 'Heartbeat e watchdog' };
export function createDefaultBehavior(kind: BehaviorKind, id = `${kind}-${Date.now().toString(36)}`): Behavior {
  const base = { id, name: behaviorNames[kind], kind, enabled: true };
  switch (kind) {
    case 'digital-io': return { ...base, kind, config: { address: 10, onMs: 500, offMs: 500 } };
    case 'analog-process': return { ...base, kind, config: { address: 10, waveform: 'ramp', min: 0, max: 1000, periodMs: 5000 } };
    case 'state-machine': return { ...base, kind, config: { commandCoil: 10, faultCoil: 11, stateRegister: 10, startMs: 1000, stopMs: 1000 } };
    case 'handshake': return { ...base, kind, config: { requestCoil: 10, busyCoil: 11, doneCoil: 12, ackCoil: 13, errorCoil: 14, cycleMs: 1000 } };
    case 'counter': return { ...base, kind, config: { sourceCoil: 10, resetCoil: 11, targetRegister: 10, step: 1, max: 65535 } };
    case 'alarm': return { ...base, kind, config: { sourceRegister: 10, alarmCoil: 10, ackCoil: 11, low: 100, high: 900, latched: false } };
    case 'heartbeat': return { ...base, kind, config: { register: 10, healthyCoil: 10, intervalMs: 1000, max: 65535 } };
  }
}

export function validateBehavior(value: unknown): value is Behavior {
  if (!value || typeof value !== 'object') return false;
  const b = value as any, c = b.config;
  const id = typeof b.id === 'string' && /^[a-z0-9_-]+$/i.test(b.id), name = typeof b.name === 'string' && b.name.trim().length > 0 && b.name.length <= 80;
  const integer = (v: unknown, min: number, max: number) => Number.isInteger(v) && Number(v) >= min && Number(v) <= max;
  const coil = (v: unknown) => integer(v, 0, 16383), register = (v: unknown) => integer(v, 0, 8191), time = (v: unknown) => integer(v, 100, 86400000), word = (v: unknown) => integer(v, 0, 65535);
  if (!id || !name || typeof b.enabled !== 'boolean' || !c || typeof c !== 'object') return false;
  switch (b.kind as BehaviorKind) {
    case 'digital-io': return coil(c.address) && time(c.onMs) && time(c.offMs);
    case 'analog-process': return register(c.address) && ['ramp', 'sine', 'random'].includes(c.waveform) && word(c.min) && word(c.max) && c.min <= c.max && time(c.periodMs);
    case 'state-machine': return coil(c.commandCoil) && coil(c.faultCoil) && c.commandCoil !== c.faultCoil && register(c.stateRegister) && time(c.startMs) && time(c.stopMs);
    case 'handshake': return [c.requestCoil, c.busyCoil, c.doneCoil, c.ackCoil, c.errorCoil].every(coil) && new Set([c.requestCoil, c.busyCoil, c.doneCoil, c.ackCoil, c.errorCoil]).size === 5 && time(c.cycleMs);
    case 'counter': return coil(c.sourceCoil) && coil(c.resetCoil) && c.sourceCoil !== c.resetCoil && register(c.targetRegister) && integer(c.step, 1, 65535) && word(c.max);
    case 'alarm': return register(c.sourceRegister) && coil(c.alarmCoil) && coil(c.ackCoil) && c.alarmCoil !== c.ackCoil && word(c.low) && word(c.high) && c.low <= c.high && typeof c.latched === 'boolean';
    case 'heartbeat': return register(c.register) && coil(c.healthyCoil) && time(c.intervalMs) && word(c.max);
    default: return false;
  }
}

export class Machine {
  readonly registers = new Uint16Array(8192);
  readonly coils = Array<boolean>(16384).fill(false);
  readonly logs: { time: string; message: string }[] = [];
  readonly history: HistoryPoint[] = [];
  readonly scenarios: Scenario[] = [];
  readonly behaviors: Behavior[] = [];
  online = false;
  latencyMs = 0;
  silent = false;
  pollIntervalMs = 1000;
  pollingEnabled = true;
  byteOrder: ByteOrder = 'AB';
  requestsReceived = 0;
  responsesSent = 0;
  pollingRequests = 0;
  commandRequests = 0;
  lastActivityAt = '';
  listenHost = '127.0.0.1';
  lastDiagnostic?: DiagnosticResult;
  manufacturer: MachineManufacturer;
  model: MachineModel;
  faults: FaultConfig = { packetLossPercent: 0, disconnectPercent: 0, corruptReadPercent: 0 };
  private server?: ServerTCP;
  private readonly clients = new Map<Socket, { id: string; address: string; port: number; connectedAt: string; lastActivityAt: string; requests: number; pending: Buffer }>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private epoch = 0;
  private readonly scenarioStates = new Map<string, boolean>();
  private readonly behaviorStates = new Map<string, Record<string, number | boolean | string>>();
  private eventSink?: (event: MachineEvent) => void;
  constructor(readonly config: Config) { this.manufacturer = config.manufacturer || (config.template === 'delta-dvp' ? 'delta' : config.template === 'mitsubishi-fx5' ? 'mitsubishi' : 'generic'); this.model = config.model || 'generic'; config.manufacturer = this.manufacturer; config.model = this.model; delete config.template; if (config.faults) this.faults = { ...config.faults }; if (config.scenarios) this.scenarios.push(...config.scenarios); if (config.behaviors) this.behaviors.push(...config.behaviors.filter(validateBehavior)); config.behaviors = this.behaviors; }
  /** Compatibilidade temporária com clientes anteriores à separação fabricante/modelo. */
  get template(): LegacyMachineTemplate { return this.manufacturer === 'delta' ? 'delta-dvp' : this.manufacturer === 'mitsubishi' ? 'mitsubishi-fx5' : 'generic'; }
  setEventSink(sink: (event: MachineEvent) => void) { this.eventSink = sink; }
  private emit(type: MachineEvent['type'], payload: Record<string, unknown>) { this.eventSink?.({ type, payload }); }
  log(message: string) { const entry = { time: new Date().toISOString(), message }; this.logs.unshift(entry); this.logs.length = Math.min(this.logs.length, 200); this.emit('log', { entry }); }
  private clientSnapshots(): ClientConnection[] {
    return [...this.clients.entries()].map(([socket, client]) => ({ id: client.id, address: client.address, port: client.port, connectedAt: client.connectedAt, lastActivityAt: client.lastActivityAt, requests: client.requests, bytesReceived: socket.bytesRead, bytesSent: socket.bytesWritten }));
  }
  private networkEndpoints(): NetworkEndpoint[] {
    if (this.listenHost !== '0.0.0.0') return [{ address: this.listenHost, interfaceName: 'Listener configurado', kind: this.listenHost === '127.0.0.1' ? 'virtual' : 'unknown' }];
    const virtualPattern = /virtual|vethernet|hyper-v|vmware|virtualbox|docker|wsl|loopback|vpn|tap|tun|tailscale|zerotier/i;
    const physicalPattern = /wi-?fi|wlan|wireless|ethernet|lan|rede local/i;
    const endpoints: NetworkEndpoint[] = [];
    for (const [interfaceName, addresses] of Object.entries(networkInterfaces())) for (const item of addresses || []) {
      if (item.family !== 'IPv4' || item.internal || endpoints.some(endpoint => endpoint.address === item.address)) continue;
      endpoints.push({ address: item.address, interfaceName, kind: virtualPattern.test(interfaceName) ? 'virtual' : physicalPattern.test(interfaceName) ? 'physical' : 'unknown' });
    }
    return endpoints;
  }
  snapshot() {
    return {
      ...this.config, online: this.online, latencyMs: this.latencyMs, silent: this.silent,
      pollIntervalMs: this.pollIntervalMs, pollingEnabled: this.pollingEnabled, byteOrder: this.byteOrder,
      requestsReceived: this.requestsReceived, responsesSent: this.responsesSent, pollingRequests: this.pollingRequests, commandRequests: this.commandRequests, lastActivityAt: this.lastActivityAt,
      manufacturer: this.manufacturer, model: this.model, template: this.template, faults: this.faults, scenarios: this.scenarios, behaviors: this.behaviors, history: this.history,
      listenHost: this.listenHost, networkAddresses: this.networkEndpoints().map(endpoint => endpoint.address), networkInterfaces: this.networkEndpoints(), clients: this.clientSnapshots(), lastDiagnostic: this.lastDiagnostic,
      registers: Array.from(this.registers), coils: this.coils, logs: this.logs
    };
  }
  private trackClient(socket: Socket) {
    const address = (socket.remoteAddress || 'desconhecido').replace(/^::ffff:/, '');
    const port = socket.remotePort || 0, now = new Date().toISOString();
    const client = { id: `${address}:${port}`, address, port, connectedAt: now, lastActivityAt: now, requests: 0, pending: Buffer.alloc(0) };
    this.clients.set(socket, client);
    this.log(`SYS Cliente Modbus conectado: ${client.id}`);
    this.emit('clients', { clients: this.clientSnapshots() });
    socket.on('data', chunk => {
      client.lastActivityAt = new Date().toISOString();
      client.pending = Buffer.concat([client.pending, chunk]);
      while (client.pending.length >= 7) {
        const payloadLength = client.pending.readUInt16BE(4), frameLength = 6 + payloadLength;
        if (payloadLength < 2 || frameLength > 65542) { client.pending = Buffer.alloc(0); break; }
        if (client.pending.length < frameLength) break;
        const frame = client.pending.subarray(0, frameLength), transaction = frame.readUInt16BE(0), unit = frame[6], fc = frame[7];
        client.requests++;
        this.log(`RX  [${client.id}] MBAP tx=${transaction} unit=${unit} FC${String(fc).padStart(2, '0')} ${frameLength} bytes`);
        client.pending = client.pending.subarray(frameLength);
      }
      this.emit('clients', { clients: this.clientSnapshots() });
    });
    socket.once('close', () => {
      const bytesReceived = socket.bytesRead, bytesSent = socket.bytesWritten, requests = client.requests;
      this.clients.delete(socket);
      this.log(`SYS Cliente Modbus desconectado: ${client.id} · ${requests} requisição(ões) · RX ${bytesReceived} B / TX ${bytesSent} B`);
      this.emit('clients', { clients: this.clientSnapshots() });
    });
    socket.on('error', error => this.log(`ERR Cliente ${client.id}: ${error.message}`));
  }
  private range(address: number, count = 1, max = this.registers.length) {
    if (!Number.isInteger(address) || !Number.isInteger(count) || count < 1 || address < 0 || address + count > max) throw Object.assign(new Error('Endereço fora do mapa'), { modbusErrorCode: 2 });
  }
  private respond<T>(label: string, action: () => T, cb: (error: Error | null, value?: T) => void) {
    const epoch = this.epoch;
    this.requestsReceived++;
    if (/^FC0[1-4]/.test(label)) this.pollingRequests++; else this.commandRequests++;
    this.lastActivityAt = new Date().toISOString();
    this.emit('traffic', { requestsReceived: this.requestsReceived, responsesSent: this.responsesSent, pollingRequests: this.pollingRequests, commandRequests: this.commandRequests, lastActivityAt: this.lastActivityAt });
    this.log(`RX  ${label}`);
    if (Math.random() * 100 < this.faults.packetLossPercent) { this.log(`ERR Falha injetada: pacote descartado em ${label}`); return; }
    if (Math.random() * 100 < this.faults.disconnectPercent) { this.log(`ERR Falha injetada: clientes desconectados em ${label}`); for (const socket of this.server?.socks.keys() || []) socket.destroy(); return; }
    // No modo silencioso a escrita é aplicada, mas sua confirmação é perdida.
    let value: T;
    try { value = action(); } catch (error) { this.log(`ERR ${label}: ${(error as Error).message}`); cb(error as Error); return; }
    if (/^FC0[1-4]/.test(label) && Math.random() * 100 < this.faults.corruptReadPercent) {
      if (typeof value === 'boolean') value = (!value) as T;
      else if (typeof value === 'number') value = (value ^ 1) as T;
      else if (Array.isArray(value) && value.length) value = [Number(value[0]) ^ 1, ...value.slice(1)] as T;
      this.log(`ERR Falha injetada: resposta corrompida em ${label}`);
    }
    if (this.silent) { this.log('ERR Resposta suprimida; operação pode ter sido aplicada.'); return; }
    const send = () => { this.responsesSent++; this.lastActivityAt = new Date().toISOString(); this.emit('traffic', { requestsReceived: this.requestsReceived, responsesSent: this.responsesSent, pollingRequests: this.pollingRequests, commandRequests: this.commandRequests, lastActivityAt: this.lastActivityAt }); this.log(`TX  ${label}`); cb(null, value); };
    if (!this.latencyMs) { send(); return; }
    const timer = setTimeout(() => { this.timers.delete(timer); if (epoch === this.epoch) send(); }, this.latencyMs);
    this.timers.add(timer);
  }
  write(address: number, values: number[]) {
    this.range(address, values.length);
    if (values.some(v => !Number.isInteger(v) || v < 0 || v > 65535)) throw new Error('Valor inválido');
    this.registers.set(values, address);
    this.emit('memory', { area: 'register', address, values });
  }
  configureBehavior(behavior: Behavior) {
    if (!validateBehavior(behavior)) throw new Error('Configuração de comportamento inválida');
    const index = this.behaviors.findIndex(item => item.id === behavior.id);
    if (index >= 0 && this.behaviors[index].kind !== behavior.kind) throw new Error('O tipo de um comportamento existente não pode ser alterado');
    if (index >= 0) this.behaviors[index] = behavior; else this.behaviors.push(behavior);
    this.config.behaviors = this.behaviors;
    this.behaviorStates.delete(behavior.id);
    this.log(`SYS Comportamento ${index >= 0 ? 'atualizado' : 'adicionado'}: ${behavior.name}`);
  }
  removeBehavior(id: string) {
    const index = this.behaviors.findIndex(item => item.id === id);
    if (index < 0) throw new Error('Comportamento não encontrado');
    const [behavior] = this.behaviors.splice(index, 1);
    this.cleanupBehavior(behavior);
    this.behaviorStates.delete(id);
    this.config.behaviors = this.behaviors;
    this.log(`SYS Comportamento removido: ${behavior.name}`);
  }
  private setBehaviorCoil(address: number, value: boolean) {
    if (this.coils[address] === value) return;
    this.coils[address] = value;
    this.emit('memory', { area: 'coil', address, values: [Number(value)] });
  }
  private setBehaviorRegister(address: number, value: number) {
    value = Math.max(0, Math.min(65535, Math.round(value)));
    if (this.registers[address] === value) return;
    this.registers[address] = value;
    this.emit('memory', { area: 'register', address, values: [value] });
  }
  private cleanupBehavior(behavior: Behavior) {
    if (behavior.kind === 'handshake') {
      this.setBehaviorCoil(behavior.config.busyCoil, false); this.setBehaviorCoil(behavior.config.doneCoil, false); this.setBehaviorCoil(behavior.config.errorCoil, false);
    } else if (behavior.kind === 'alarm') this.setBehaviorCoil(behavior.config.alarmCoil, false);
    else if (behavior.kind === 'heartbeat') this.setBehaviorCoil(behavior.config.healthyCoil, false);
  }
  evaluateBehaviors(now = Date.now()) {
    for (const behavior of this.behaviors) {
      if (!behavior.enabled) { this.cleanupBehavior(behavior); this.behaviorStates.delete(behavior.id); continue; }
      let state = this.behaviorStates.get(behavior.id);
      if (!state) { state = {}; this.behaviorStates.set(behavior.id, state); }
      const c: any = behavior.config;
      switch (behavior.kind) {
        case 'digital-io': {
          if (state.startedAt === undefined) state.startedAt = now;
          const elapsed = now - Number(state.startedAt), period = c.onMs + c.offMs;
          this.setBehaviorCoil(c.address, elapsed % period < c.onMs);
          break;
        }
        case 'analog-process': {
          if (state.startedAt === undefined) state.startedAt = now;
          const elapsed = now - Number(state.startedAt), progress = (elapsed % c.periodMs) / c.periodMs, range = c.max - c.min;
          let value: number;
          if (c.waveform === 'sine') value = c.min + ((Math.sin(progress * Math.PI * 2 - Math.PI / 2) + 1) / 2) * range;
          else if (c.waveform === 'random') {
            const bucket = Math.floor(elapsed / c.periodMs);
            if (state.bucket !== bucket) { state.bucket = bucket; state.randomValue = c.min + Math.random() * range; }
            value = Number(state.randomValue ?? c.min);
          } else value = c.min + progress * range;
          this.setBehaviorRegister(c.address, value);
          break;
        }
        case 'state-machine': {
          let phase = Number(state.phase ?? 0), phaseAt = Number(state.phaseAt ?? now);
          if (this.coils[c.faultCoil]) { phase = 4; phaseAt = now; }
          else if (phase === 4) { phase = this.coils[c.commandCoil] ? 1 : 0; phaseAt = now; }
          else if (phase === 0 && this.coils[c.commandCoil]) { phase = 1; phaseAt = now; }
          else if (phase === 1 && !this.coils[c.commandCoil]) { phase = 3; phaseAt = now; }
          else if (phase === 1 && now - phaseAt >= c.startMs) { phase = 2; phaseAt = now; }
          else if (phase === 2 && !this.coils[c.commandCoil]) { phase = 3; phaseAt = now; }
          else if (phase === 3 && this.coils[c.commandCoil]) { phase = 1; phaseAt = now; }
          else if (phase === 3 && now - phaseAt >= c.stopMs) { phase = 0; phaseAt = now; }
          state.phase = phase; state.phaseAt = phaseAt; this.setBehaviorRegister(c.stateRegister, phase);
          break;
        }
        case 'handshake': {
          const request = this.coils[c.requestCoil], previousRequest = Boolean(state.previousRequest);
          if (request && !previousRequest && !state.busy && !state.done) {
            state.busy = true; state.done = false; state.finishAt = now + c.cycleMs;
            this.setBehaviorCoil(c.errorCoil, false); this.setBehaviorCoil(c.busyCoil, true); this.setBehaviorCoil(c.doneCoil, false);
          }
          if (state.busy && now >= Number(state.finishAt)) {
            state.busy = false; state.done = true; this.setBehaviorCoil(c.busyCoil, false); this.setBehaviorCoil(c.doneCoil, true);
          }
          if (state.done && this.coils[c.ackCoil]) { state.done = false; this.setBehaviorCoil(c.doneCoil, false); }
          state.previousRequest = request;
          break;
        }
        case 'counter': {
          const source = this.coils[c.sourceCoil];
          if (this.coils[c.resetCoil]) this.setBehaviorRegister(c.targetRegister, 0);
          else if (source && !state.previousSource) { const next = this.registers[c.targetRegister] + c.step; this.setBehaviorRegister(c.targetRegister, next > c.max ? 0 : next); }
          state.previousSource = source;
          break;
        }
        case 'alarm': {
          const value = this.registers[c.sourceRegister], active = value < c.low || value > c.high;
          if (active) state.latched = true;
          if (!active && c.latched && this.coils[c.ackCoil]) state.latched = false;
          this.setBehaviorCoil(c.alarmCoil, c.latched ? Boolean(state.latched) : active);
          break;
        }
        case 'heartbeat': {
          this.setBehaviorCoil(c.healthyCoil, true);
          if (state.lastAt === undefined) state.lastAt = now;
          const elapsed = now - Number(state.lastAt), steps = Math.floor(elapsed / c.intervalMs);
          if (steps > 0) { this.setBehaviorRegister(c.register, (this.registers[c.register] + steps) % (c.max + 1)); state.lastAt = Number(state.lastAt) + steps * c.intervalMs; }
          break;
        }
      }
    }
  }
  configureScenario(scenario: Scenario) {
    const index = this.scenarios.findIndex(item => item.id === scenario.id);
    if (index >= 0) this.scenarios[index] = scenario; else this.scenarios.push(scenario);
    this.config.scenarios = this.scenarios;
    this.scenarioStates.delete(scenario.id);
    this.log(`SYS Cenário salvo: ${scenario.name}`);
  }
  removeScenario(id: string) { const index = this.scenarios.findIndex(item => item.id === id); if (index >= 0) this.scenarios.splice(index, 1); this.config.scenarios = this.scenarios; this.scenarioStates.delete(id); this.log(`SYS Cenário removido: ${id}`); }
  runScenario(scenario: Scenario) {
    if (scenario.targetArea === 'coil') this.coils[scenario.targetAddress] = Boolean(scenario.targetValue);
    else this.registers[scenario.targetAddress] = scenario.targetValue;
    this.emit('memory', { area: scenario.targetArea, address: scenario.targetAddress, values: [scenario.targetValue] });
    scenario.lastRunAt = Date.now();
    this.log(`SYS Cenário ${scenario.name}: ${scenario.targetArea} ${scenario.targetAddress} = ${scenario.targetValue}`);
  }
  private evaluateScenarios() {
    const now = Date.now();
    for (const scenario of this.scenarios.filter(item => item.enabled)) {
      if (scenario.trigger === 'interval') { if (now - scenario.lastRunAt >= scenario.intervalMs) this.runScenario(scenario); continue; }
      const current = scenario.trigger === 'coil' ? Number(this.coils[scenario.conditionAddress]) : this.registers[scenario.conditionAddress];
      const matched = current === scenario.conditionValue, previous = this.scenarioStates.get(scenario.id) || false;
      if (matched && !previous) this.runScenario(scenario);
      this.scenarioStates.set(scenario.id, matched);
    }
  }
  private captureHistory() {
    if (!this.pollingEnabled) return;
    this.history.push({ time: new Date().toISOString(), register0: this.registers[0], register1: this.registers[1], register2: this.registers[2], deltaD0: this.registers[4096], coil0: Number(this.coils[0]), coil1: Number(this.coils[1]), rx: this.requestsReceived, tx: this.responsesSent });
    if (this.history.length > 300) this.history.shift();
    this.emit('history', { point: this.history.at(-1) });
  }
  reset() {
    this.registers.fill(0); this.coils.fill(false); this.behaviorStates.clear();
    this.log('Memória zerada; comportamentos reinicializados.');
    this.emit('refresh', {});
  }
  clearRegisters() {
    this.registers.fill(0);
    this.log('SYS Todos os holding registers foram zerados. Coils preservados.');
    this.emit('refresh', {});
  }
  private diagnosticAddresses() {
    const usedRegisters = new Set<number>(), usedCoils = new Set<number>();
    for (const behavior of this.behaviors) {
      for (const [key, value] of Object.entries(behavior.config)) {
        if (typeof value !== 'number') continue;
        const normalized = key.toLowerCase();
        if (normalized.includes('register') || normalized === 'address' && behavior.kind === 'analog-process') usedRegisters.add(value);
        if (normalized.includes('coil') || normalized === 'address' && behavior.kind === 'digital-io') usedCoils.add(value);
      }
    }
    for (const scenario of this.scenarios) {
      (scenario.targetArea === 'register' ? usedRegisters : usedCoils).add(scenario.targetAddress);
      if (scenario.trigger === 'register') usedRegisters.add(scenario.conditionAddress);
      if (scenario.trigger === 'coil') usedCoils.add(scenario.conditionAddress);
    }
    let registerAddress = this.registers.length - 2;
    while (registerAddress > 0 && (usedRegisters.has(registerAddress) || usedRegisters.has(registerAddress + 1))) registerAddress--;
    let coilAddress = this.coils.length - 1;
    while (coilAddress > 0 && usedCoils.has(coilAddress)) coilAddress--;
    return { registerAddress, coilAddress };
  }
  async runDiagnostic(): Promise<DiagnosticResult> {
    const started = Date.now(), startedAt = new Date(started).toISOString();
    const { registerAddress, coilAddress } = this.diagnosticAddresses();
    const originalRegisters = [this.registers[registerAddress], this.registers[registerAddress + 1]], originalCoil = this.coils[coilAddress];
    const targetHost = this.listenHost === '0.0.0.0' ? '127.0.0.1' : this.listenHost;
    const target = `${targetHost}:${this.config.port} · Unit ${this.config.unitId}`;
    const checks: DiagnosticCheck[] = [];
    const client = new ModbusRTU(); client.setID(this.config.unitId); client.setTimeout(Math.max(2000, this.latencyMs + 1500));
    const check = async (id: string, label: string, action: () => Promise<string>) => {
      const checkStarted = Date.now();
      try { const detail = await action(); checks.push({ id, label, ok: true, durationMs: Date.now() - checkStarted, detail }); }
      catch (error) { checks.push({ id, label, ok: false, durationMs: Date.now() - checkStarted, detail: (error as Error).message }); }
    };
    this.log(`SYS Autoteste iniciado em ${target}; área temporária holding ${registerAddress}–${registerAddress + 1} e coil ${coilAddress}`);
    try {
      await check('tcp', 'Conexão TCP', async () => { await client.connectTCP(targetHost, { port: this.config.port }); return 'Sessão Modbus TCP estabelecida'; });
      if (!client.isOpen) throw new Error('Não foi possível estabelecer a sessão de teste');
      await check('fc01', 'FC01 · Read Coils', async () => { const value = (await client.readCoils(coilAddress, 1)).data[0]; return `coil ${coilAddress} = ${Number(value)}`; });
      await check('fc02', 'FC02 · Read Discrete Inputs', async () => { const value = (await client.readDiscreteInputs(coilAddress, 1)).data[0]; return `entrada ${coilAddress} = ${Number(value)}`; });
      await check('fc03', 'FC03 · Read Holding Registers', async () => { const values = (await client.readHoldingRegisters(registerAddress, 2)).data; return `holding ${registerAddress}–${registerAddress + 1} = ${values.join(', ')}`; });
      await check('fc04', 'FC04 · Read Input Registers', async () => { const value = (await client.readInputRegisters(registerAddress, 1)).data[0]; return `input ${registerAddress} = ${value}`; });
      await check('fc05', 'FC05 · Write Single Coil', async () => { const expected = !originalCoil; await client.writeCoil(coilAddress, expected); const actual = (await client.readCoils(coilAddress, 1)).data[0]; if (actual !== expected) throw new Error(`retorno ${Number(actual)}, esperado ${Number(expected)}`); return `escrita e releitura confirmadas em ${coilAddress}`; });
      await check('fc06', 'FC06 · Write Single Register', async () => { const expected = originalRegisters[1] ^ 0x5a5a; await client.writeRegister(registerAddress + 1, expected); const actual = (await client.readHoldingRegisters(registerAddress + 1, 1)).data[0]; if (actual !== expected) throw new Error(`retorno ${actual}, esperado ${expected}`); return `escrita e releitura confirmadas em ${registerAddress + 1}`; });
      await check('fc16', 'FC16 · Write Multiple Registers', async () => { const expected = [originalRegisters[0] ^ 0xa55a, originalRegisters[1] ^ 0x5aa5]; await client.writeRegisters(registerAddress, expected); const actual = (await client.readHoldingRegisters(registerAddress, 2)).data; if (actual[0] !== expected[0] || actual[1] !== expected[1]) throw new Error(`retorno ${actual.join(', ')}, esperado ${expected.join(', ')}`); return `bloco ${registerAddress}–${registerAddress + 1} confirmado`; });
      await check('restore', 'Restauração da memória', async () => { await client.writeRegisters(registerAddress, originalRegisters); await client.writeCoil(coilAddress, originalCoil); return 'Valores originais restaurados via Modbus'; });
    } catch (error) {
      if (!checks.some(item => item.id === 'tcp' && !item.ok)) checks.push({ id: 'session', label: 'Sessão de autoteste', ok: false, durationMs: 0, detail: (error as Error).message });
    } finally {
      client.destroy(() => {});
      this.registers.set(originalRegisters, registerAddress); this.coils[coilAddress] = originalCoil;
      this.emit('memory', { area: 'register', address: registerAddress, values: originalRegisters });
      this.emit('memory', { area: 'coil', address: coilAddress, values: [Number(originalCoil)] });
    }
    const finished = Date.now(), failed = checks.some(item => !item.ok) || checks.length < 8;
    this.lastDiagnostic = { status: failed ? 'failed' : 'passed', startedAt, finishedAt: new Date(finished).toISOString(), durationMs: finished - started, target, registerAddress, coilAddress, checks, ...(failed ? { error: 'Uma ou mais verificações falharam' } : {}) };
    this.log(`SYS Autoteste ${failed ? 'falhou' : 'concluído com sucesso'} em ${this.lastDiagnostic.durationMs} ms`);
    this.emit('refresh', {});
    return this.lastDiagnostic;
  }
  async start(host = '127.0.0.1') {
    if (this.server) return;
    const vector = {
      getCoil: (a: number, _u: number, cb: any) => this.respond(`FC01 coil ${a}`, () => { this.range(a, 1, this.coils.length); return this.coils[a]; }, cb),
      getDiscreteInput: (a: number, _u: number, cb: any) => this.respond(`FC02 entrada ${a}`, () => { this.range(a, 1, this.coils.length); return this.coils[a]; }, cb),
      getHoldingRegister: (a: number, _u: number, cb: any) => this.respond(`FC03 registro ${a}`, () => { this.range(a); return this.registers[a]; }, cb),
      getMultipleHoldingRegisters: (a: number, n: number, _u: number, cb: any) => this.respond(`FC03 registros ${a} +${n}`, () => { this.range(a, n); return Array.from(this.registers.slice(a, a + n)); }, cb),
      getInputRegister: (a: number, _u: number, cb: any) => this.respond(`FC04 entrada ${a}`, () => { this.range(a); return this.registers[a]; }, cb),
      setRegister: (a: number, v: number, _u: number, cb: any) => this.respond(`FC06 registro ${a} = ${v}`, () => this.write(a, [v]), cb),
      setRegisterArray: (a: number, v: number[], _u: number, cb: any) => this.respond(`FC16 registros ${a} +${v.length}`, () => this.write(a, v), cb),
      setCoil: (a: number, v: boolean, _u: number, cb: any) => this.respond(`FC05 coil ${a} = ${v}`, () => { this.range(a, 1, this.coils.length); this.coils[a] = v; this.emit('memory', { area: 'coil', address: a, values: [Number(v)] }); }, cb)
    };
    this.listenHost = host;
    const server = this.server = new ServerTCP(vector, { host, port: this.config.port, unitID: this.config.unitId });
    const tcpServer = (server as ServerTCP & { _server?: NetServer })._server;
    tcpServer?.on('connection', socket => this.trackClient(socket));
    server.on('socketError', error => this.log(`Socket: ${error?.message}`));
    server.on('serverError', error => this.log(`Servidor: ${error?.message}`));
    await new Promise<void>((resolve, reject) => {
      server.once('initialized', () => { server.removeListener('serverError', reject); this.online = true; this.log(`Modbus disponível em ${host}:${this.config.port}`); resolve(); });
      server.once('serverError', reject);
    }).catch(error => { this.server = undefined; throw error; });
    this.emit('status', { online: true });
    const scenarioTimer = setInterval(() => this.evaluateScenarios(), 250); this.timers.add(scenarioTimer);
    const behaviorTimer = setInterval(() => this.evaluateBehaviors(), 100); this.timers.add(behaviorTimer);
    const historyTimer = setInterval(() => this.captureHistory(), Math.max(250, this.pollIntervalMs)); this.timers.add(historyTimer);
  }
  async stop() {
    this.epoch++;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const behavior of this.behaviors) this.cleanupBehavior(behavior);
    this.behaviorStates.clear();
    const server = this.server; this.server = undefined; this.online = false;
    this.clients.clear();
    this.emit('status', { online: false });
    if (server) { for (const socket of server.socks.keys()) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
    this.log('Conexão desligada. Memória preservada.');
  }
}
