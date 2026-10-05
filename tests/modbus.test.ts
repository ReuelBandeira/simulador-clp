import { test } from 'node:test';
import assert from 'node:assert/strict';
import ModbusRTU from 'modbus-serial';
import { Machine } from '../src/machine';
import { createConnection, createServer } from 'node:net';

async function port() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return value;
}

test('servidor genérico aceita leitura e escrita de coils e registradores', async t => {
  const machine = new Machine({ id: 'generic', name: 'Genérico', port: await port(), unitId: 1 });
  await machine.start('127.0.0.1');
  const client = new ModbusRTU(); client.setID(1); client.setTimeout(500);
  t.after(async () => { client.destroy(() => {}); await machine.stop(); });
  await client.connectTCP('127.0.0.1', { port: machine.config.port });
  await client.writeRegister(25, 1234); await client.writeCoil(26, true);
  assert.equal((await client.readHoldingRegisters(25, 1)).data[0], 1234);
  assert.equal((await client.readCoils(26, 1)).data[0], true);
  assert.equal(machine.commandRequests, 2);
  assert.equal(machine.pollingRequests, 2);
  assert.ok(machine.logs.some(log => log.message.startsWith('RX')));
  assert.ok(machine.logs.some(log => log.message.startsWith('TX')));
});

test('memória é isolada entre estações e preservada ao reiniciar o listener', async t => {
  const first = new Machine({ id: 'first', name: 'First', port: await port(), unitId: 1 });
  const second = new Machine({ id: 'second', name: 'Second', port: await port(), unitId: 1 });
  await first.start(); await second.start();
  const client = new ModbusRTU(); client.setID(1); client.setTimeout(500);
  t.after(async () => { client.destroy(() => {}); await first.stop(); await second.stop(); });
  await client.connectTCP('127.0.0.1', { port: first.config.port });
  await client.writeRegister(50, 321);
  assert.equal(first.registers[50], 321); assert.equal(second.registers[50], 0);
  client.destroy(() => {}); await first.stop(); await first.start();
  assert.equal(first.registers[50], 321); assert.equal(first.online, true);
});

test('template Delta com modelo genérico expõe D0 em 4096 e cenário escreve no alias', () => {
  const machine = new Machine({ id: 'delta', name: 'Delta', port: 1502, unitId: 1, manufacturer: 'delta', model: 'generic' });
  const scenario = { id: 'set-d0', name: 'Set D0', enabled: true, trigger: 'interval' as const, intervalMs: 1000, conditionAddress: 0, conditionValue: 0, targetArea: 'register' as const, targetAddress: 4096, targetValue: 321, lastRunAt: 0 };
  machine.configureScenario(scenario); machine.runScenario(scenario);
  assert.equal(machine.manufacturer, 'delta'); assert.equal(machine.model, 'generic');
  assert.equal(machine.registers[4096], 321); assert.equal(machine.config.scenarios?.[0].id, 'set-d0');
});

test('injeção de falha pode corromper leitura Modbus de forma determinística', async t => {
  const machine = new Machine({ id: 'fault', name: 'Fault injection', port: await port(), unitId: 1 });
  machine.registers[10] = 100; machine.faults.corruptReadPercent = 100;
  await machine.start('127.0.0.1');
  const client = new ModbusRTU(); client.setID(1); client.setTimeout(500);
  t.after(async () => { client.destroy(() => {}); await machine.stop(); });
  await client.connectTCP('127.0.0.1', { port: machine.config.port });
  assert.equal((await client.readHoldingRegisters(10, 1)).data[0], 101);
  assert.ok(machine.logs.some(log => log.message.includes('resposta corrompida')));
});

test('template Mitsubishi com modelo genérico expõe D0 no holding 0 e M0 no coil 8192', async t => {
  const machine = new Machine({ id: 'mitsubishi', name: 'Mitsubishi', port: await port(), unitId: 1, manufacturer: 'mitsubishi', model: 'generic' });
  await machine.start('127.0.0.1');
  const client = new ModbusRTU(); client.setID(1); client.setTimeout(500);
  t.after(async () => { client.destroy(() => {}); await machine.stop(); });
  await client.connectTCP('127.0.0.1', { port: machine.config.port });
  await client.writeRegister(0, 456); await client.writeCoil(8192, true);
  assert.equal((await client.readHoldingRegisters(0, 1)).data[0], 456);
  assert.equal((await client.readCoils(8192, 1)).data[0], true);
});

test('autoteste valida funções Modbus e restaura a memória usada', async t => {
  const machine = new Machine({ id: 'diagnostic', name: 'Diagnostic', port: await port(), unitId: 7 });
  machine.registers[8190] = 123; machine.registers[8191] = 456; machine.coils[16383] = true;
  await machine.start('127.0.0.1');
  t.after(async () => { await machine.stop(); });
  const result = await machine.runDiagnostic();
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.checks.map(check => check.id), ['tcp', 'fc01', 'fc02', 'fc03', 'fc04', 'fc05', 'fc06', 'fc16', 'restore']);
  assert.ok(result.checks.every(check => check.ok));
  assert.equal(machine.registers[result.registerAddress], 123);
  assert.equal(machine.registers[result.registerAddress + 1], 456);
  assert.equal(machine.coils[result.coilAddress], true);
});

test('painel rastreia cliente TCP, requisições e desconexão', async t => {
  const machine = new Machine({ id: 'clients', name: 'Clients', port: await port(), unitId: 1 });
  await machine.start('127.0.0.1');
  const client = new ModbusRTU(); client.setID(1); client.setTimeout(500);
  t.after(async () => { client.destroy(() => {}); await machine.stop(); });
  await client.connectTCP('127.0.0.1', { port: machine.config.port });
  await client.readHoldingRegisters(0, 1);
  await new Promise(resolve => setTimeout(resolve, 20));
  const connected = machine.snapshot().clients;
  assert.equal(connected.length, 1);
  assert.match(connected[0].address, /127\.0\.0\.1/);
  assert.ok(connected[0].requests >= 1);
  assert.ok(connected[0].bytesReceived > 0);
  client.destroy(() => {});
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(machine.snapshot().clients.length, 0);
  assert.ok(machine.logs.some(log => log.message.includes('Cliente Modbus conectado')));
  assert.ok(machine.logs.some(log => log.message.includes('Cliente Modbus desconectado')));
});

test('função Modbus não suportada recebe exceção protocolar em vez de ficar sem resposta', async t => {
  const machine = new Machine({ id: 'illegal-fc', name: 'Illegal FC', port: await port(), unitId: 1 });
  await machine.start('127.0.0.1');
  t.after(async () => { await machine.stop(); });
  const response = await new Promise<Buffer>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: machine.config.port }, () => {
      socket.write(Buffer.from([0, 1, 0, 0, 0, 4, 1, 99, 0, 0]));
    });
    socket.once('data', data => { socket.destroy(); resolve(data); });
    socket.once('error', reject);
  });
  assert.equal(response[7], 99 | 0x80);
  assert.equal(response[8], 0x01);
});

test('zerar holding registers preserva coils e configurações da estação', () => {
  const machine = new Machine({ id: 'clear-registers', name: 'Clear registers', port: 1502, unitId: 1 });
  machine.registers[0] = 123; machine.registers[8191] = 456; machine.coils[0] = true;
  machine.clearRegisters();
  assert.equal(machine.registers[0], 0);
  assert.equal(machine.registers[8191], 0);
  assert.equal(machine.coils[0], true);
  assert.ok(machine.logs.some(log => log.message.includes('holding registers foram zerados')));
});
