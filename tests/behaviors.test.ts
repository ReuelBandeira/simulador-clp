import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Machine, createDefaultBehavior, validateBehavior, type Behavior, type BehaviorKind } from '../src/machine';

function machineWith(behavior: Behavior) {
  return new Machine({ id: 'behavior-test', name: 'Behavior test', port: 1502, unitId: 1, behaviors: [behavior] });
}

test('os sete comportamentos padrão são válidos e endereços conflitantes no mesmo módulo são rejeitados', () => {
  const kinds: BehaviorKind[] = ['digital-io', 'analog-process', 'state-machine', 'handshake', 'counter', 'alarm', 'heartbeat'];
  for (const kind of kinds) assert.equal(validateBehavior(createDefaultBehavior(kind, `default_${kind}`)), true, kind);
  const invalid = createDefaultBehavior('handshake', 'invalid') as Extract<Behavior,{kind:'handshake'}>;
  invalid.config.doneCoil = invalid.config.busyCoil;
  assert.equal(validateBehavior(invalid), false);
});

test('sinal digital alterna conforme os tempos configurados', () => {
  const m = machineWith({ id: 'digital', name: 'Sensor', kind: 'digital-io', enabled: true, config: { address: 10, onMs: 200, offMs: 300 } });
  m.evaluateBehaviors(0); assert.equal(m.coils[10], true);
  m.evaluateBehaviors(250); assert.equal(m.coils[10], false);
  m.evaluateBehaviors(500); assert.equal(m.coils[10], true);
});

test('processo analógico produz rampa limitada', () => {
  const m = machineWith({ id: 'analog', name: 'Nível', kind: 'analog-process', enabled: true, config: { address: 20, waveform: 'ramp', min: 100, max: 200, periodMs: 1000 } });
  m.evaluateBehaviors(0); assert.equal(m.registers[20], 100);
  m.evaluateBehaviors(500); assert.equal(m.registers[20], 150);
  m.evaluateBehaviors(999); assert.ok(m.registers[20] >= 199 && m.registers[20] <= 200);
});

test('máquina de estados parte, executa, para e entra em falha', () => {
  const m = machineWith({ id: 'state', name: 'Máquina', kind: 'state-machine', enabled: true, config: { commandCoil: 20, faultCoil: 21, stateRegister: 30, startMs: 200, stopMs: 300 } });
  m.evaluateBehaviors(0); assert.equal(m.registers[30], 0);
  m.coils[20] = true; m.evaluateBehaviors(10); assert.equal(m.registers[30], 1);
  m.evaluateBehaviors(210); assert.equal(m.registers[30], 2);
  m.coils[20] = false; m.evaluateBehaviors(220); assert.equal(m.registers[30], 3);
  m.evaluateBehaviors(520); assert.equal(m.registers[30], 0);
  m.coils[21] = true; m.evaluateBehaviors(530); assert.equal(m.registers[30], 4);
});

test('handshake genérico percorre request, busy, done e ack', () => {
  const m = machineWith({ id: 'hs', name: 'Handshake', kind: 'handshake', enabled: true, config: { requestCoil: 30, busyCoil: 31, doneCoil: 32, ackCoil: 33, errorCoil: 34, cycleMs: 250 } });
  m.evaluateBehaviors(0);
  m.coils[30] = true; m.evaluateBehaviors(10);
  assert.equal(m.coils[31], true); assert.equal(m.coils[32], false);
  m.evaluateBehaviors(260);
  assert.equal(m.coils[31], false); assert.equal(m.coils[32], true);
  m.coils[33] = true; m.evaluateBehaviors(270);
  assert.equal(m.coils[32], false);
});

test('contador incrementa apenas na borda e aceita reset', () => {
  const m = machineWith({ id: 'counter', name: 'Peças', kind: 'counter', enabled: true, config: { sourceCoil: 40, resetCoil: 41, targetRegister: 40, step: 2, max: 5 } });
  m.evaluateBehaviors(0); m.coils[40] = true; m.evaluateBehaviors(10); assert.equal(m.registers[40], 2);
  m.evaluateBehaviors(20); assert.equal(m.registers[40], 2);
  m.coils[40] = false; m.evaluateBehaviors(30); m.coils[40] = true; m.evaluateBehaviors(40); assert.equal(m.registers[40], 4);
  m.coils[40] = false; m.evaluateBehaviors(50); m.coils[40] = true; m.evaluateBehaviors(60); assert.equal(m.registers[40], 0);
  m.coils[41] = true; m.registers[40] = 4; m.evaluateBehaviors(70); assert.equal(m.registers[40], 0);
});

test('alarme memorizado exige condição normal e reconhecimento', () => {
  const m = machineWith({ id: 'alarm', name: 'Pressão', kind: 'alarm', enabled: true, config: { sourceRegister: 50, alarmCoil: 50, ackCoil: 51, low: 10, high: 90, latched: true } });
  m.registers[50] = 100; m.evaluateBehaviors(0); assert.equal(m.coils[50], true);
  m.registers[50] = 50; m.evaluateBehaviors(10); assert.equal(m.coils[50], true);
  m.coils[51] = true; m.evaluateBehaviors(20); assert.equal(m.coils[50], false);
});

test('heartbeat incrementa, faz rollover e publica saúde', () => {
  const m = machineWith({ id: 'heartbeat', name: 'Watchdog', kind: 'heartbeat', enabled: true, config: { register: 60, healthyCoil: 60, intervalMs: 100, max: 2 } });
  m.evaluateBehaviors(0); assert.equal(m.coils[60], true); assert.equal(m.registers[60], 0);
  m.evaluateBehaviors(100); assert.equal(m.registers[60], 1);
  m.evaluateBehaviors(200); assert.equal(m.registers[60], 2);
  m.evaluateBehaviors(300); assert.equal(m.registers[60], 0);
});

test('comportamentos são independentes e permanecem na configuração', () => {
  const behaviors: Behavior[] = [
    { id: 'digital', name: 'Sensor', kind: 'digital-io', enabled: true, config: { address: 70, onMs: 200, offMs: 100 } },
    { id: 'heartbeat', name: 'Vida', kind: 'heartbeat', enabled: true, config: { register: 70, healthyCoil: 71, intervalMs: 100, max: 10 } }
  ];
  const m = new Machine({ id: 'two', name: 'Two', port: 1502, unitId: 1, behaviors });
  m.evaluateBehaviors(0);
  m.evaluateBehaviors(100);
  assert.equal(m.coils[70], true); assert.equal(m.coils[71], true); assert.equal(m.registers[70], 1);
  assert.equal(m.snapshot().behaviors.length, 2);
});
