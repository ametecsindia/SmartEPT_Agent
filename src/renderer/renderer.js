'use strict';
/* SmartEPT Agent renderer — drives the login -> consent -> live-status flow. */

const $ = (id) => document.getElementById(id);
const views = { login: $('view-login'), consent: $('view-consent'), dash: $('view-dash') };
function show(name) {
  Object.values(views).forEach((v) => v.classList.remove('active'));
  views[name].classList.add('active');
}
const fmtMin = (sec) => {
  sec = sec || 0;
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
};
const fmtTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

let currentPolicy = null;

// ---- boot ----
(async () => {
  const boot = await window.smartept.boot();
  $('server').value = boot.server_url || 'http://smartept.test';
  if (boot.has_session) {
    const res = await window.smartept.resume();
    if (res.ok) {
      currentPolicy = res.policy;
      $('emp-name').textContent = res.employee?.name || '—';
      if (res.consent.consent_required && !res.consent.has_consented) {
        renderConsent(res.policy); show('consent');
      } else {
        renderFlags(res.policy); show('dash');
      }
      return;
    }
  }
  show('login');
})();

// Prefill the saved / IT-provisioned server URL; lock the field when provisioned.
window.smartept.boot().then((b) => {
  if (b && b.server_url && !$('server').value) $('server').value = b.server_url;
  if (b && b.server_locked) {
    $('server').disabled = true;
    $('server-hint').textContent = '(set by your IT team)';
  }
}).catch(() => {});

$('btn-test').addEventListener('click', async (ev) => {
  ev.preventDefault();
  const m = $('test-msg');
  m.textContent = 'Testing\u2026';
  const res = await window.smartept.testConnection({ server_url: $('server').value });
  m.textContent = res.ok ? ('\u2713 Connected to SmartEPT' + (res.version ? ' v' + res.version : '')) : ('\u2715 ' + res.error);
});

// ---- login ----
$('btn-login').addEventListener('click', async () => {
  const btn = $('btn-login'); btn.disabled = true; $('login-err').textContent = '';
  const res = await window.smartept.login({
    server_url: $('server').value, email: $('email').value, password: $('password').value,
  });
  btn.disabled = false;
  if (!res.ok) { $('login-err').textContent = res.error || 'Sign-in failed.'; return; }

  currentPolicy = res.policy;
  $('emp-name').textContent = res.employee?.name || '—';

  if (res.consent.consent_required && !res.consent.has_consented) {
    renderConsent(res.policy); show('consent');
  } else {
    await window.smartept.startTracking(); renderFlags(res.policy); show('dash');
  }
});

// ---- consent ----
function renderConsent(p) {
  const rows = [
    ['Active / idle time tracking', p.tracking_enabled],
    ['Application usage', p.app_usage],
    ['Website usage', p.website_usage],
    ['Screenshots', p.screenshot_enabled],
    ['Webcam presence (no video)', p.webcam_presence],
  ];
  $('consent-list').innerHTML = rows.map(([label, on]) =>
    `<div class="row"><span>${label}</span><span class="tag ${on ? 'on' : 'off'}">${on ? 'ON' : 'OFF'}</span></div>`
  ).join('');
}
$('btn-consent').addEventListener('click', async () => {
  const btn = $('btn-consent'); btn.disabled = true; $('consent-err').textContent = '';
  const res = await window.smartept.giveConsent();
  btn.disabled = false;
  if (!res.ok) { $('consent-err').textContent = res.error || 'Could not record consent.'; return; }
  renderFlags(currentPolicy); show('dash');
});

// ---- dashboard ----
function renderFlags(p) {
  if (!p) return;
  const items = [
    ['Tracking', p.tracking_enabled], ['Screenshots', p.screenshot_enabled],
    ['Webcam presence', p.webcam_presence], ['App usage', p.app_usage], ['Website usage', p.website_usage],
  ];
  $('flags').innerHTML = items.map(([l, on]) => `<span class="flag ${on ? 'active' : ''}">${l}: ${on ? 'on' : 'off'}</span>`).join('');
  $('policy-line').textContent = p.name || '';
}

document.querySelectorAll('.breaks button[data-b]').forEach((b) => {
  b.addEventListener('click', () => window.smartept.break({ action: 'START', break_type: b.dataset.b }));
});
$('btn-break-end').addEventListener('click', () => window.smartept.break({ action: 'END', break_type: 'CUSTOM' }));
$('btn-logout').addEventListener('click', async () => { await window.smartept.logout(); location.reload(); });

// ---- live updates ----
const stateColors = { ACTIVE: 'var(--ok)', IDLE: 'var(--idle)', AWAY: 'var(--warn)' };
window.smartept.onState((s) => {
  $('state-dot').style.background = stateColors[s.state] || 'var(--ink-3)';
  $('state-label').textContent = s.tracking ? (s.state === 'ACTIVE' ? 'Active' : 'Idle') : 'Not tracking';
  $('sync-line').textContent = `Sync: ${s.online ? 'online' : 'offline'}${s.pending ? ' · ' + s.pending + ' pending' : ''}`;
  if (s.employee) $('emp-name').textContent = s.employee.name;
  if (s.policy) { currentPolicy = s.policy; renderFlags(s.policy); }
});
window.smartept.onToday((t) => {
  $('k-login').textContent = fmtTime(t.logged_in_at);
  $('k-active').textContent = fmtMin(t.active_seconds);
  $('k-idle').textContent = fmtMin(t.idle_seconds);
  $('k-break').textContent = fmtMin(t.break_seconds);
});

// Visible policy-alert banner (blocked app/site).
window.smartept.onAlert((a) => {
  let bar = document.getElementById('alert-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'alert-bar';
    bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;background:#F2647F;color:#0A0D13;'
      + 'font-weight:700;font-size:12px;padding:9px 14px;text-align:center;z-index:99';
    document.body.appendChild(bar);
  }
  bar.textContent = '⚠ ' + (a.message || 'Policy alert');
  bar.style.display = 'block';
  clearTimeout(bar._t);
  bar._t = setTimeout(() => { bar.style.display = 'none'; }, 6000);
});
