const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

/* =========================
   Electron startup hardening
   حل مشكلة Access is denied في Cache / GPU cache
========================= */
const safeAppData = process.env.LOCALAPPDATA || process.env.APPDATA || process.cwd();
const safeUserData = path.join(safeAppData, 'MohasebOfflineCloud');
const safeSessionData = path.join(safeUserData, 'SessionData');
const safeCache = path.join(safeUserData, 'Cache');

// يجب ضبط هذه المسارات قبل app.whenReady() حتى لا يستخدم Electron
// مجلدات Cache قديمة أو مقفلة من نسخة أخرى من البرنامج.
app.setPath('userData', safeUserData);
app.setPath('sessionData', safeSessionData);
app.setPath('cache', safeCache);

// تجنب مشاكل GPU cache على بعض أجهزة Windows أثناء الاختبار والتشغيل.
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

const supabase = require('./supabase-client');
const cloudConfig = require('./cloud-config');

let mainWindow;
let syncTimer = null;
let syncRunning = false;
let cloudOnline = false;
let cachedDeviceId = null;

/* =========================
   ملفات المزامنة المحلية
========================= */

function syncPaths() {
  const dir = path.join(app.getPath('userData'), 'sync');

  fs.mkdirSync(dir, { recursive: true });

  return {
    dir,
    queue: path.join(dir, 'queue.json'),
    meta: path.join(dir, 'meta.json')
  };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
   const tmp = `${file}.tmp`;

  fs.writeFileSync(
    tmp,
    JSON.stringify(value, null, 2),
    'utf8'
  );

  fs.renameSync(tmp, file);
}

function ensureSyncFiles() {
  const p = syncPaths();

  if (!fs.existsSync(p.queue)) {
    writeJson(p.queue, []);
  }

  if (!fs.existsSync(p.meta)) {
    writeJson(p.meta, {
      deviceId: crypto.randomUUID(),
      cloudEnabled: true,
      lastSuccessfulSync: null
    });
  }

  return p;
}
function getMeta() {
  const p = ensureSyncFiles();

  const meta = readJson(p.meta, {
    deviceId: crypto.randomUUID(),
    cloudEnabled: true,
    lastSuccessfulSync: null
  });

  // تفعيل المزامنة السحابية
  if (meta.cloudEnabled !== true) {
    meta.cloudEnabled = true;
    saveMeta(meta);
  }

  return meta;
}

function saveMeta(meta) {
  const p = ensureSyncFiles();

  writeJson(p.meta, meta);
}

function getQueue() {
  const p = ensureSyncFiles();

  return readJson(p.queue, []);
}

function saveQueue(queue) {
  const p = ensureSyncFiles();

  writeJson(p.queue, queue);
}

/* =========================
   جهاز المحل في Supabase
========================= */

async function getCloudDeviceId(forceRefresh = false) {
  // نستخدم الـ cache في عمليات المزامنة العادية، لكن يمكن إجبار
  // الفحص على الاتصال بالسحابة فعليًا عند التحقق من حالة الإنترنت.
  if (cachedDeviceId && !forceRefresh) {
    return cachedDeviceId;
  }

  const deviceCode =
    cloudConfig.deviceCode || 'SHOP-PC-001';

  const { data, error } = await supabase
    .from('devices')
    .select('id, device_code, is_active')
    .eq('device_code', deviceCode)
    .single();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new Error(
      'جهاز المحل غير موجود في جدول devices'
    );
  }

  if (data.is_active === false) {
    throw new Error(
      'جهاز المحل غير فعال في السحابة'
    );
  }

  cachedDeviceId = data.id;

  return data.id;
}

/* =========================
   فحص الاتصال بالسحابة
========================= */

async function checkCloudConnection() {
  try {
    // مهم: لا نعتمد على cachedDeviceId هنا، لأن وجوده لا يعني أن
    // الإنترنت ما زال متاحًا. نجبر getCloudDeviceId على تنفيذ
    // طلب جديد إلى Supabase في كل فحص للحالة.
    await getCloudDeviceId(true);

    cloudOnline = true;

    return true;
  } catch (error) {
    cloudOnline = false;

    return false;
  }
}

/* =========================
   تجهيز العملية
========================= */

function normalizeOperation(operation) {
  const op = operation || {};

  return {
    event_id:
      op.event_id ||
      op.eventId ||
      crypto.randomUUID(),

    event_type:
      op.event_type ||
      op.eventType ||
      'sync_operation',

    occurred_at:
      op.occurred_at ||
      op.occurredAt ||
      new Date().toISOString(),

    payload:
      op.payload !== undefined
        ? op.payload
        : op
  };
}

/* =========================
   إرسال عملية إلى Supabase
========================= */

async function uploadOperation(operation) {
  const deviceId = await getCloudDeviceId();

  const normalized =
    normalizeOperation(operation);

  const event = {
    id: normalized.event_id,

    device_id: deviceId,

    event_type:
      normalized.event_type,

    occurred_at:
      normalized.occurred_at,

    payload:
      normalized.payload
  };

  // Idempotent upload: if the same event_id was already accepted by
  // Supabase but the acknowledgement was lost (for example, because
  // the network dropped immediately after the insert), retrying the
  // queue must NOT create a duplicate or leave the event stuck forever.
  // The browser sync already uses the same merge-duplicates strategy.
  const { error } = await supabase
    .from('business_events')
    .upsert(event, {
      onConflict: 'id',
      ignoreDuplicates: true
    });

  if (error) {
    throw error;
  }

  return event;
}


/* =========================
   سحب العمليات من Supabase
========================= */

async function pullCloudEvents() {
  const meta = getMeta();
  const lastEventAt = meta.lastPulledEventAt || null;
  let events = [];

  await getCloudDeviceId(true);
  cloudOnline = true;

  if (!lastEventAt) {
    const { data: snapshots, error: snapshotError } = await supabase
      .from('business_events')
      .select('id,device_id,event_type,occurred_at,payload')
      .eq('event_type', 'sync_snapshot')
      .order('occurred_at', { ascending: false })
      .limit(1);

    if (snapshotError) throw snapshotError;

    if (!snapshots || !snapshots.length) {
      return { ok: true, online: true, events: [], bootstrapMissing: true };
    }

    const snapshot = snapshots[0];
    const { data: tail, error: tailError } = await supabase
      .from('business_events')
      .select('id,device_id,event_type,occurred_at,payload')
      .gt('occurred_at', snapshot.occurred_at)
      .order('occurred_at', { ascending: true })
      .limit(1000);

    if (tailError) throw tailError;
    events = [snapshot, ...(tail || [])];
  } else {
    const { data: rows, error } = await supabase
      .from('business_events')
      .select('id,device_id,event_type,occurred_at,payload')
      .gte('occurred_at', lastEventAt)
      .order('occurred_at', { ascending: true })
      .limit(1000);

    if (error) throw error;
    events = rows || [];
  }

  const seen = new Set(meta.seenEventIds || []);
  const fresh = events.filter(e => e && e.id && !seen.has(e.id));
  return { ok: true, online: true, events: fresh, bootstrapMissing: false };
}

function markCloudEventsApplied(events) {
  if (!Array.isArray(events) || !events.length) return;
  const meta = getMeta();
  const seen = new Set(meta.seenEventIds || []);
  let last = meta.lastPulledEventAt || null;

  for (const event of events) {
    if (event && event.id) seen.add(event.id);
    if (event && event.occurred_at && (!last || String(event.occurred_at) > String(last))) {
      last = event.occurred_at;
    }
  }

  meta.seenEventIds = [...seen].slice(-5000);
  if (last) meta.lastPulledEventAt = last;
  saveMeta(meta);
}

/* =========================
   تشغيل المزامنة
========================= */

async function processSyncQueue() {
  if (syncRunning) {
    return {
      ok: true,
      skipped: true,
      reason: 'sync_already_running'
    };
  }

  const meta = getMeta();
if (meta.cloudEnabled === false) {
    return {
      ok: true,
      skipped: true,
      reason: 'cloud_disabled'
    };
  }

  const queue = getQueue();

  /* لا توجد عمليات معلقة */
  if (queue.length === 0) {
    const online =
      await checkCloudConnection();

    return {
      ok: online,
      online,
      successful: 0,
      pendingOperations: 0,
      lastSuccessfulSync:
        getMeta().lastSuccessfulSync || null
    };
  }

  syncRunning = true;

  let successful = 0;

  try {
    /*
      إذا لم يوجد إنترنت أو حدث خطأ،
      لن نحذف أي عملية من الـQueue.
    */

    try {
      await getCloudDeviceId();

      cloudOnline = true;
    } catch (error) {
      cloudOnline = false;

      return {
        ok: false,
        online: false,
        successful: 0,
        pendingOperations: queue.length,
        error: error.message
      };
    }

    const remaining = [];

    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];

      try {
        await uploadOperation(
          item.operation
        );

        successful++;
      } catch (error) {
        cloudOnline = false;

        /*
          العملية التي فشلت + كل العمليات بعدها
          تبقى في الـQueue.
        */

        remaining.push(item);

        for (
          let j = i + 1;
          j < queue.length;
          j++
        ) {
          remaining.push(queue[j]);
        }

        break;
      }
    }

    saveQueue(remaining);

    if (successful > 0) {
      const newMeta = getMeta();

      newMeta.cloudEnabled = true;

      newMeta.lastSuccessfulSync =
        new Date().toISOString();

      saveMeta(newMeta);
    }

    return {
      ok: cloudOnline,
      online: cloudOnline,
      successful,
      pendingOperations:
        remaining.length,
      lastSuccessfulSync:
        getMeta().lastSuccessfulSync || null
    };
  } finally {
    syncRunning = false;
  }
}

/* =========================
   إضافة عملية محليًا
========================= */

function enqueueOperation(operation) {
  const queue = getQueue();

  const event_id = operation?.event_id || crypto.randomUUID();
  const normalizedOperation = { ...(operation || {}), event_id };

  const item = {
    id: event_id,

    createdAt:
      new Date().toISOString(),

    status: 'pending',

    operation: normalizedOperation
  };

  // هذه العملية أنشأها هذا الجهاز، لذلك لا نعيد تطبيقها عندما
  // نقرأ سجل الأحداث من السحابة لاحقاً.
  const meta = getMeta();
  const seen = new Set(meta.seenEventIds || []);
  seen.add(event_id);
  meta.seenEventIds = [...seen].slice(-5000);
  saveMeta(meta);

  queue.push(item);

  /*
    الحفظ المحلي يتم أولًا.
    لذلك البرنامج يعمل حتى بدون إنترنت.
  */

  saveQueue(queue);

  /*
    نحاول المزامنة في الخلفية.
    لا ننتظرها حتى لا يتوقف المحاسب.
  */

  processSyncQueue().catch(() => {});

  return {
    ok: true,
    pendingOperations:
      queue.length,

    operationId:
      item.id
  };
}

/* =========================
   نافذة البرنامج
========================= */

function createWindow() {
  mainWindow =
    new BrowserWindow({
      width: 1440,
      height: 900,

      minWidth: 1100,
      minHeight: 700,

      show: false,

      autoHideMenuBar: true,

      backgroundColor: '#f7fafc',

      webPreferences: {
        preload:
          path.join(
            __dirname,
            'preload.js'
          ),

        contextIsolation: true,

        nodeIntegration: false,

        sandbox: true
      }
    });

  mainWindow.loadFile(
    path.join(
      __dirname,
      'index.html'
    )
  );

  mainWindow.once(
    'ready-to-show',
    () => {
      mainWindow.show();
    }
  );
}

/* =========================
   تشغيل Electron
========================= */

app.whenReady().then(async () => {
  ensureSyncFiles();

  /* =========================
     حالة المزامنة
  ========================= */

  ipcMain.handle(
    'sync:status',
    async () => {
      const p =
        ensureSyncFiles();

      const queue =
        readJson(
          p.queue,
          []
        );

      const meta =
        readJson(
          p.meta,
          {}
        );

      const online =
        await checkCloudConnection();

      return {
        online,

        cloudEnabled:
          meta.cloudEnabled !== false,

        pendingOperations:
          queue.length,

        lastSuccessfulSync:
          meta.lastSuccessfulSync ||
          null,

        deviceId:
          meta.deviceId ||
          null,
cloudDeviceCode:
          cloudConfig.deviceCode ||
          'SHOP-PC-001'
      };
    }
  );

  /* =========================
     إضافة عملية للـQueue
  ========================= */

  ipcMain.handle(
    'sync:enqueue',
    (_event, operation) => {
      return enqueueOperation(
        operation
      );
    }
  );

  /* =========================
     تصدير الـQueue
  ========================= */

  ipcMain.handle(
    'sync:export-queue',
    () => {
      return getQueue();
    }
  );

  /* =========================
     سحب العمليات من السحابة
  ========================= */

  ipcMain.handle(
    'sync:pull',
    async () => {
      try {
        return await pullCloudEvents();
      } catch (error) {
        cloudOnline = false;
        return { ok: false, online: false, events: [], error: error.message };
      }
    }
  );

  ipcMain.handle(
    'sync:mark-pulled',
    (_event, events) => {
      markCloudEventsApplied(events);
      return { ok: true };
    }
  );

  /* =========================
     تشغيل المزامنة يدويًا
  ========================= */

  ipcMain.handle(
    'sync:now',
    async () => {
      return await processSyncQueue();
    }
  );

  /* =========================
     اختبار المزامنة
  ========================= */

  ipcMain.handle(
    'sync:test',
    async () => {
      return enqueueOperation({
        event_type:
          'sync_test',

        occurred_at:
          new Date().toISOString(),

        payload: {
          message:
            'اختبار المزامنة من برنامج Windows',

          deviceCode:
            cloudConfig.deviceCode ||
            'SHOP-PC-001'
        }
      });
    }
  );

  /* =========================
     مزامنة تلقائية كل 10 ثوانٍ
  ========================= */

  syncTimer =
    setInterval(() => {
      processSyncQueue()
        .catch(() => {});
    }, 10000);

  /* =========================
     محاولة مزامنة عند التشغيل
  ========================= */

  processSyncQueue()
    .catch(() => {});

  /* =========================
     إنشاء النافذة
  ========================= */

  createWindow();

  app.on(
    'activate',
    () => {
      if (
        BrowserWindow
          .getAllWindows()
          .length === 0
      ) {
        createWindow();
      }
    }
  );
});

/* =========================
   إغلاق البرنامج
========================= */

app.on(
  'before-quit',
  () => {
    if (syncTimer) {
      clearInterval(syncTimer);

      syncTimer = null;
    }
  }
);

app.on(
  'window-all-closed',
  () => {
    if (
      process.platform !==
      'darwin'
    ) {
      app.quit();
    }
  }
);