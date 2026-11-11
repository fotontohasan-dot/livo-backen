// Step 4 D1 — opsMetrics: INFO parse, breaker state map, and refresh with injected fakes (no Redis/DB needed).
const client = require('prom-client');
const ops = require('../../services/opsMetrics');

const INFO_MEM = '# Memory\r\nused_memory:52428800\r\nmaxmemory:104857600\r\n';
const INFO_CLI = '# Clients\r\nconnected_clients:42\r\n';
const INFO_ST = '# Stats\r\nevicted_keys:7\r\n';

function fakeRedis() {
  return { info: async (section) => ({ memory: INFO_MEM, clients: INFO_CLI, stats: INFO_ST })[section] };
}

describe('opsMetrics helpers', () => {
  test('parseRedisInfo skips comments and parses key:value', () => {
    const o = ops.parseRedisInfo(INFO_MEM + INFO_CLI);
    expect(o.used_memory).toBe('52428800');
    expect(o.connected_clients).toBe('42');
    expect(Object.keys(o).some((k) => k.startsWith('#'))).toBe(false);
  });

  test('redisSnapshot: ratio when maxmemory set, null when unlimited', () => {
    expect(ops.redisSnapshot({ used_memory: '50', maxmemory: '100' }).ratio).toBe(0.5);
    expect(ops.redisSnapshot({ used_memory: '50', maxmemory: '0' }).ratio).toBeNull();
    expect(ops.redisSnapshot({}).usedBytes).toBe(0);
  });

  test('breakerStateValue maps states, unknown -> -1', () => {
    expect(ops.breakerStateValue('closed')).toBe(0);
    expect(ops.breakerStateValue('half_open')).toBe(1);
    expect(ops.breakerStateValue('open')).toBe(2);
    expect(ops.breakerStateValue('weird')).toBe(-1);
  });
});

describe('refreshOpsMetrics', () => {
  test('fills gauges from injected sources; a failing source does not stop the rest', async () => {
    const register = new client.Registry();
    const gauges = ops.createOpsGauges(client, register);
    await ops.refreshOpsMetrics(gauges, {
      db: { pool: { totalCount: 8, idleCount: 3 } },
      redisTargets: [['queue', () => fakeRedis()], ['cache', () => { throw new Error('boom'); }]],
      queueHealth: { getQueueHealthStats: async () => ({ queues: [{ name: 'api-log', enabled: true, counts: { waiting: 12, active: 1 } }] }) },
      apiLogger: { getApiLogStats: () => ({ dropped: 5, failed: 1, pending: 9 }) },
      breakers: { getAllBreakerSnapshots: () => [{ name: 'sports:cricapi', state: 'open', windowErrorRate: 0.8 }] }
    });
    const text = await register.metrics();
    expect(text).toMatch(/bet420_db_pool_in_use 5/);
    expect(text).toMatch(/bet420_redis_memory_ratio\{instance="queue"\} 0\.5/);
    expect(text).toMatch(/bet420_redis_connected_clients\{instance="queue"\} 42/);
    expect(text).toMatch(/bet420_redis_evicted_keys\{instance="queue"\} 7/);
    expect(text).toMatch(/bet420_redis_info_ok\{instance="cache"\} 0/);
    expect(text).toMatch(/bet420_bullmq_jobs\{queue="api-log",state="waiting"\} 12/);
    expect(text).toMatch(/bet420_apilog_dropped 5/);
    expect(text).toMatch(/bet420_circuit_breaker_state\{name="sports:cricapi"\} 2/);
  });

  test('createOpsGauges(null) is a no-op, refresh(null) never throws', async () => {
    expect(ops.createOpsGauges(null, null)).toBeNull();
    await expect(ops.refreshOpsMetrics(null)).resolves.toBeUndefined();
  });
});
