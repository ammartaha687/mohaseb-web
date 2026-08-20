/*
 * Web/Browser sync adapter.
 * Uses the Supabase REST API directly so the same index.html can run in
 * Chrome/Android without Electron. It is intentionally independent from
 * the shop's Electron queue: the shop remains Offline-first.
 */
(function () {
  const cfg = {
    url: 'https://pbyosypgcakawfiwayap.supabase.co',
    key: 'sb_publishable_jR4jm7CG9zY9A57qjd7eDA_FkZPs2gM',
    deviceCode: 'SHOP-PC-001'
  };

  const API = cfg.url.replace(/\/$/, '') + '/rest/v1';
  const DB_NAME = 'MohasebWebSyncDB';
  const DB_VERSION = 1;
  let deviceId = null;
  let syncBusy = false;

  const headers = () => ({
    apikey: cfg.key,
    Authorization: 'Bearer ' + cfg.key,
    'Content-Type': 'application/json'
  });

  const uuid = () => {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
    return 'web-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  };

  const openDB = () => new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  const metaGet = async (key, fallback = null) => {
    try {
      const db = await openDB();
      return await new Promise((resolve, reject) => {
        const req = db.transaction('meta', 'readonly').objectStore('meta').get(key);
        req.onsuccess = () => resolve(req.result ? req.result.value : fallback);
        req.onerror = () => reject(req.error);
      });
    } catch (_) { return fallback; }
  };

  const metaSet = async (key, value) => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction('meta', 'readwrite').objectStore('meta').put({ key, value });
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  };

  const queueAdd = async (operation) => {
    const db = await openDB();
    const id = operation.event_id || uuid();
    const op = { ...operation, event_id: id };
    return new Promise((resolve, reject) => {
      const req = db.transaction('queue', 'readwrite').objectStore('queue').put({ id, operation: op, createdAt: new Date().toISOString() });
      req.onsuccess = () => resolve({ ok: true, operationId: id });
      req.onerror = () => reject(req.error);
    });
  };

  const queueAll = async () => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction('queue', 'readonly').objectStore('queue').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  };

  const queueDelete = async (id) => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction('queue', 'readwrite').objectStore('queue').delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  };

  const rest = async (path, options = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    try {
      const response = await fetch(API + path, {
        ...options,
        headers: { ...headers(), ...(options.headers || {}) },
        signal: controller.signal
      });
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
      if (!response.ok) {
        const message = data && data.message ? data.message : (typeof data === 'string' ? data : ('HTTP ' + response.status));
        throw new Error(message);
      }
      return data;
    } finally { clearTimeout(timer); }
  };

  const getDeviceId = async () => {
    if (deviceId) return deviceId;
    const code = encodeURIComponent(cfg.deviceCode);
    const rows = await rest(`/devices?select=id,device_code,is_active&device_code=eq.${code}&limit=1`);
    if (!Array.isArray(rows) || !rows.length) throw new Error('جهاز السحابة غير موجود: ' + cfg.deviceCode);
    if (rows[0].is_active === false) throw new Error('جهاز السحابة غير فعال');
    deviceId = rows[0].id;
    return deviceId;
  };

  const uploadOperation = async (operation) => {
    const id = operation.event_id || uuid();
    const event = {
      id,
      device_id: await getDeviceId(),
      event_type: operation.event_type || 'sync_operation',
      occurred_at: operation.occurred_at || new Date().toISOString(),
      payload: operation.payload !== undefined ? operation.payload : operation
    };
    await rest('/business_events', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(event)
    });
    return event;
  };

  const flushQueue = async () => {
    const queue = await queueAll();
    let successful = 0;
    for (const item of queue) {
      try {
        await uploadOperation(item.operation);
        await queueDelete(item.id);
        await markLocalEvent(item.id);
        successful++;
      } catch (error) {
        return { ok: false, online: false, successful, pendingOperations: queue.length - successful, error: error.message };
      }
    }
    return { ok: true, online: true, successful, pendingOperations: 0 };
  };

  const getSeen = async () => (await metaGet('seenIds', [])) || [];
  const saveSeen = async (ids) => {
    const trimmed = ids.slice(-2000);
    await metaSet('seenIds', trimmed);
  };

  const pullEvents = async () => {
    const snapshotApplied = await metaGet('snapshotAppliedId', null);
    const lastAt = await metaGet('lastEventAt', null);
    let events = [];

    if (!snapshotApplied) {
      const snapshots = await rest('/business_events?select=id,device_id,event_type,occurred_at,payload&event_type=eq.sync_snapshot&order=occurred_at.desc&limit=1');
      if (Array.isArray(snapshots) && snapshots.length) {
        const snapshot = snapshots[0];
        const after = encodeURIComponent(snapshot.occurred_at);
        const tail = await rest(`/business_events?select=id,device_id,event_type,occurred_at,payload&occurred_at=gt.${after}&order=occurred_at.asc&limit=1000`);
        events = [snapshot, ...(Array.isArray(tail) ? tail : [])];
      } else {
        // No bootstrap snapshot yet. Do not replay the entire historical log.
        await metaSet('bootstrapMissing', true);
        return { ok: true, online: true, events: [], bootstrapMissing: true };
      }
    } else {
      const cursor = lastAt || '1970-01-01T00:00:00.000Z';
      const after = encodeURIComponent(cursor);
      const rows = await rest(`/business_events?select=id,device_id,event_type,occurred_at,payload&occurred_at=gte.${after}&order=occurred_at.asc&limit=1000`);
      events = Array.isArray(rows) ? rows : [];
    }

    const seen = new Set(await getSeen());
    const fresh = events.filter(e => e && e.id && !seen.has(e.id));
    return { ok: true, online: true, events: fresh, snapshot: fresh.find(e => e.event_type === 'sync_snapshot') || null };
  };

  const markLocalEvent = async (id) => {
    if (!id) return;
    const seen = await getSeen();
    if (!seen.includes(id)) seen.push(id);
    await saveSeen(seen);
  };

  const markApplied = async (events) => {
    if (!events || !events.length) return;
    const seen = await getSeen();
    const set = new Set(seen);
    let lastAt = await metaGet('lastEventAt', null);
    let snapshotId = await metaGet('snapshotAppliedId', null);
    for (const event of events) {
      if (event.id) set.add(event.id);
      if (!lastAt || String(event.occurred_at) > String(lastAt)) lastAt = event.occurred_at;
      if (event.event_type === 'sync_snapshot') snapshotId = event.id;
    }
    await saveSeen([...set]);
    if (snapshotId) await metaSet('snapshotAppliedId', snapshotId);
    if (lastAt) await metaSet('lastEventAt', lastAt);
    await metaSet('bootstrapMissing', false);
  };

  const pullAndApply = async () => {
    if (syncBusy) return { ok: true, skipped: true };
    syncBusy = true;
    try {
      const result = await pullEvents();
      if (result.events && result.events.length && typeof window.applyRemoteSyncEvents === 'function') {
        await window.applyRemoteSyncEvents(result.events);
        await markApplied(result.events);
      }
      return result;
    } finally { syncBusy = false; }
  };

  const enqueue = async (operation) => {
    const op = { ...operation, event_id: operation.event_id || uuid() };
    await queueAdd(op);
    // Never wait for cloud availability before returning to the user.
    flushQueue().catch(() => {});
    return { ok: true, pendingOperations: (await queueAll()).length, operationId: op.event_id };
  };

  const status = async () => {
    try {
      await getDeviceId();
      const queue = await queueAll();
      return { online: true, cloudEnabled: true, pendingOperations: queue.length, lastSuccessfulSync: await metaGet('lastSuccessfulSync', null), deviceId };
    } catch (error) {
      return { online: false, cloudEnabled: true, pendingOperations: (await queueAll()).length, lastSuccessfulSync: await metaGet('lastSuccessfulSync', null), error: error.message };
    }
  };

  const syncNow = async () => {
    const pushed = await flushQueue();
    if (!pushed.online) return pushed;
    const pulled = await pullAndApply();
    if (pushed.successful > 0) await metaSet('lastSuccessfulSync', new Date().toISOString());
    return { ...pushed, pulled: pulled.events ? pulled.events.length : 0, bootstrapMissing: !!pulled.bootstrapMissing };
  };

  window.mohasebWebSync = { enqueue, status, syncNow, pull: pullAndApply, markApplied, markLocalEvent };
})();
