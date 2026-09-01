'use strict';

/**
 * FHIR Patient Manager — frontend
 * --------------------------------
 * All patient data is read from / written to the FHIR R4 server through the
 * backend proxy (/api/fhir/*). There is no mock data and no local persistence:
 * the in-memory array below is only a cache of the last server response.
 */

(() => {
  const $ = (id) => document.getElementById(id);

  // ── DOM ────────────────────────────────────────────────────────────────
  const els = {
    connectionText: $('connection-text'),
    connectionPill: $('connection-pill'),
    errorBanner: $('error-banner'),
    errorMessage: $('error-message'),
    errorDismiss: $('error-dismiss'),
    searchInput: $('search-input'),
    addPatientBtn: $('add-patient-btn'),
    listTitle: $('list-title'),
    patientCount: $('patient-count'),
    loadingState: $('loading-state'),
    emptyState: $('empty-state'),
    emptyTitle: $('empty-title'),
    emptyText: $('empty-text'),
    tableWrap: $('table-wrap'),
    patientsBody: $('patients-body'),
    footerServer: $('footer-server'),
    modalOverlay: $('modal-overlay'),
    modalTitle: $('modal-title'),
    modalClose: $('modal-close'),
    modalLoading: $('modal-loading'),
    patientForm: $('patient-form'),
    fGiven: $('f-given'),
    fFamily: $('f-family'),
    fGender: $('f-gender'),
    fDob: $('f-dob'),
    cancelBtn: $('cancel-btn'),
    saveBtn: $('save-btn'),
    saveLabel: $('save-label'),
    saveSpinner: $('save-spinner'),
    toast: $('toast'),
    errGiven: $('err-given'),
    errFamily: $('err-family'),
    errGender: $('err-gender'),
    errDob: $('err-dob'),
  };

  // ── State (UI cache only — data always comes from the server) ───────────
  const state = {
    patients: [],
    loading: false,
    saving: false,
    searchQuery: '',
    searchTimer: null,
    editingId: null,        // null => create mode
    editingResource: null,  // full resource fetched from the server for edit
  };

  const GENDERS = ['male', 'female', 'other', 'unknown'];
  const genderLabel = (g) => (g ? g.charAt(0).toUpperCase() + g.slice(1) : '—');
  const genderClass = (g) => `badge badge-${GENDERS.includes(g) ? g : 'unknown'}`;

  // ── Error type ──────────────────────────────────────────────────────────
  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }

  // ── FHIR API helper (talks to the local proxy) ──────────────────────────
  async function fhirFetch(path, options = {}) {
    let res;
    try {
      res = await fetch(`/api/fhir${path}`, {
        method: options.method || 'GET',
        headers: {
          Accept: 'application/fhir+json, application/json',
          ...(options.body ? { 'Content-Type': 'application/fhir+json' } : {}),
        },
        body: options.body || undefined,
      });
    } catch (err) {
      throw new ApiError(`Network error: cannot reach the FHIR proxy (is the backend running?). ${err.message}`);
    }

    const raw = await res.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { /* non-JSON body */ }

    if (!res.ok) {
      let issue = data?.error || res.statusText;
      if (data?.resourceType === 'OperationOutcome') {
        const i = data.issue?.[0];
        issue = i?.diagnostics || i?.details?.text || i?.code || 'OperationOutcome';
      }
      throw new ApiError(`FHIR request failed (HTTP ${res.status}): ${issue}`, res.status);
    }
    return data;
  }

  // ── Data loading (paginated; follows Bundle "next" links) ───────────────
  async function loadPatients(query) {
    setLoading(true);
    try {
      // FHIR `name` search parameter: partial (starts-with) matching.
      // Note: the `name:contains` modifier gives true substring matching but is
      // disabled on some servers (e.g. HAPI-1258 on this MedBlocks server).
      const firstUrl = query
        ? `/Patient?name=${encodeURIComponent(query)}&_count=100`
        : '/Patient?_count=100&_sort=-_lastUpdated';

      const patients = [];
      let url = firstUrl;
      while (url) {
        const bundle = await fhirFetch(url);
        for (const entry of bundle.entry || []) {
          if (entry.resource && entry.resource.resourceType === 'Patient') patients.push(entry.resource);
        }
        const next = (bundle.link || []).find((l) => l.relation === 'next');
        url = next ? next.url : null; // proxy rewrote it to a relative path
      }

      state.patients = patients;
    } catch (err) {
      state.patients = [];
      showError(err.message);
    } finally {
      setLoading(false); // re-renders
    }
  }

  // ── Rendering ───────────────────────────────────────────────────────────
  function render() {
    const list = state.patients;
    const count = list.length;

    els.patientCount.textContent = count === 0 ? '' : `${count} patient${count === 1 ? '' : 's'}`;
    els.listTitle.textContent = state.searchQuery ? `Results for “${state.searchQuery}”` : 'Patients';

    const showTable = count > 0;
    els.tableWrap.hidden = !showTable;
    els.emptyState.hidden = showTable || state.loading;

    if (!showTable && !state.loading) {
      els.emptyTitle.textContent = state.searchQuery ? 'No matching patients' : 'No patients yet';
      els.emptyText.textContent = state.searchQuery
        ? `No patient names match “${state.searchQuery}”. Try a different partial name.`
        : 'Add your first patient with the “Add Patient” button — it will be written to the FHIR server.';
    }

    els.patientsBody.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const p of list) frag.appendChild(renderRow(p));
    els.patientsBody.appendChild(frag);
  }

  function patientFullName(p) {
    const names = Array.isArray(p.name) ? p.name : [];
    const n = names.find((x) => x.use === 'official') || names[0] || {};
    const given = Array.isArray(n.given) ? n.given.join(' ') : n.given || '';
    const family = n.family || '';
    return `${given} ${family}`.trim() || '(unnamed patient)';
  }

  function formatDob(p) {
    if (!p.birthDate) return '—';
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(p.birthDate);
    if (!m) return p.birthDate;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (Number.isNaN(d.getTime())) return p.birthDate;
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  }

  const PENCIL_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';

  function renderRow(p) {
    const tr = document.createElement('tr');

    const nameTd = document.createElement('td');
    nameTd.className = 'cell-name';
    nameTd.textContent = patientFullName(p);

    const genderTd = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = genderClass(p.gender);
    badge.textContent = genderLabel(p.gender);
    genderTd.appendChild(badge);

    const dobTd = document.createElement('td');
    dobTd.textContent = formatDob(p);

    const actionsTd = document.createElement('td');
    actionsTd.className = 'cell-actions';
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn btn-edit';
    editBtn.dataset.patientId = p.id;
    editBtn.innerHTML = `${PENCIL_SVG} Edit`;
    editBtn.setAttribute('aria-label', `Edit ${patientFullName(p)}`);
    actionsTd.appendChild(editBtn);

    tr.append(nameTd, genderTd, dobTd, actionsTd);
    return tr;
  }

  // ── Loading / saving indicators ─────────────────────────────────────────
  function setLoading(visible) {
    state.loading = visible;
    els.loadingState.hidden = !visible;
    if (!visible) render();
  }

  function setSaving(visible) {
    state.saving = visible;
    els.saveBtn.disabled = visible;
    els.saveLabel.textContent = visible ? (state.editingId ? 'Updating…' : 'Creating…') : (state.editingId ? 'Update patient' : 'Save patient');
    els.saveSpinner.hidden = !visible;
  }

  function showModalLoading(visible) {
    els.modalLoading.hidden = !visible;
  }

  // ── Error banner & toast ────────────────────────────────────────────────
  function showError(message) {
    els.errorMessage.textContent = message;
    els.errorBanner.hidden = false;
  }

  let toastTimer = null;
  function showToast(message, type = 'success') {
    els.toast.textContent = message;
    els.toast.className = `toast toast-${type}`;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, 4200);
  }

  // ── Modal: open / close / fill ──────────────────────────────────────────
  function openModal(title) {
    els.modalTitle.textContent = title;
    els.modalOverlay.hidden = false;
    document.body.classList.add('modal-open');
    els.fGiven.focus();
  }

  function closeModal() {
    els.modalOverlay.hidden = true;
    document.body.classList.remove('modal-open');
    state.editingId = null;
    state.editingResource = null;
  }

  function openCreateModal() {
    state.editingId = null;
    state.editingResource = null;
    resetForm();
    setSaving(false);
    openModal('Add patient');
  }

  async function openEditModal(id) {
    state.editingId = id;
    state.editingResource = null;
    resetForm();
    setSaving(false);
    openModal('Edit patient');
    showModalLoading(true);
    try {
      // Always re-read the latest resource from the server before editing.
      const resource = await fhirFetch(`/Patient/${encodeURIComponent(id)}`);
      state.editingResource = resource;
      fillForm(resource);
    } catch (err) {
      closeModal();
      showError(err.message);
    } finally {
      showModalLoading(false);
    }
  }

  function fillForm(resource) {
    const names = Array.isArray(resource.name) ? resource.name : [];
    const n = names.find((x) => x.use === 'official') || names[0] || {};
    els.fGiven.value = (Array.isArray(n.given) ? n.given.join(' ') : n.given || '').trim();
    els.fFamily.value = n.family || '';
    els.fGender.value = GENDERS.includes(resource.gender) ? resource.gender : '';
    els.fDob.value = resource.birthDate || '';
  }

  function resetForm() {
    els.patientForm.reset();
    clearAllFieldErrors();
  }

  // ── Validation ──────────────────────────────────────────────────────────
  const fieldErrorMap = { given: 'errGiven', family: 'errFamily', gender: 'errGender', dob: 'errDob' };
  const fieldInputMap = { given: 'fGiven', family: 'fFamily', gender: 'fGender', dob: 'fDob' };

  function showFieldErrors(errors) {
    for (const key of Object.keys(fieldErrorMap)) {
      const errEl = els[fieldErrorMap[key]];
      const input = els[fieldInputMap[key]];
      const msg = errors[key] || '';
      errEl.textContent = msg;
      errEl.hidden = !msg;
      input.classList.toggle('input-error', Boolean(msg));
    }
  }

  function clearAllFieldErrors() {
    for (const key of Object.keys(fieldErrorMap)) {
      els[fieldErrorMap[key]].hidden = true;
      els[fieldErrorMap[key]].textContent = '';
      els[fieldInputMap[key]].classList.remove('input-error');
    }
  }

  function clearFieldError(key) {
    els[fieldErrorMap[key]].hidden = true;
    els[fieldErrorMap[key]].textContent = '';
    els[fieldInputMap[key]].classList.remove('input-error');
  }

  function validateForm() {
    const errors = {};
    const givenRaw = els.fGiven.value.trim();
    const familyRaw = els.fFamily.value.trim();
    const gender = els.fGender.value;
    const dob = els.fDob.value;

    if (!givenRaw) errors.given = 'Given name(s) are required.';
    if (!familyRaw) errors.family = 'Family name is required.';
    if (!gender) errors.gender = 'Please select a gender.';
    else if (!GENDERS.includes(gender)) errors.gender = 'Invalid gender value.';

    if (!dob) {
      errors.dob = 'Date of birth is required.';
    } else if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
      errors.dob = 'Use the YYYY-MM-DD format.';
    } else {
      const [y, m, d] = dob.split('-').map(Number);
      const date = new Date(Date.UTC(y, m - 1, d));
      if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
        errors.dob = 'That is not a valid calendar date.';
      } else if (date.getTime() > Date.now()) {
        errors.dob = 'Date of birth cannot be in the future.';
      }
    }

    return { errors, values: { givenRaw, familyRaw, gender, dob } };
  }

  // ── Submit (POST create / PUT update) ───────────────────────────────────
  async function handleSubmit(e) {
    e.preventDefault();
    if (state.saving) return;

    const { errors, values } = validateForm();
    showFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      showError('Please fix the highlighted fields before saving.');
      return;
    }

    const given = values.givenRaw.split(/[\s,]+/).filter(Boolean);

    setSaving(true);
    try {
      if (state.editingId) {
        // Preserve every field the server already has; update only the edited ones.
        const base = state.editingResource || { resourceType: 'Patient', id: state.editingId };
        const names = Array.isArray(base.name) && base.name.length
          ? base.name.map((n) => ({ ...n }))
          : [{ use: 'official' }];
        names[0] = { ...names[0], use: names[0].use || 'official', family: values.familyRaw, given };
        const updated = { ...base, id: state.editingId, name: names, gender: values.gender, birthDate: values.dob };
        await fhirFetch(`/Patient/${encodeURIComponent(state.editingId)}`, {
          method: 'PUT',
          body: JSON.stringify(updated),
        });
        showToast('Patient updated on the FHIR server.');
      } else {
        const resource = {
          resourceType: 'Patient',
          name: [{ use: 'official', family: values.familyRaw, given }],
          gender: values.gender,
          birthDate: values.dob,
        };
        await fhirFetch('/Patient', { method: 'POST', body: JSON.stringify(resource) });
        showToast('Patient created on the FHIR server.');
      }

      closeModal();
      await loadPatients(state.searchQuery); // refresh straight from the server
    } catch (err) {
      showError(err.message);
    } finally {
      setSaving(false);
    }
  }

  // ── Config badge (shows which server we are talking to — never the token) ─
  async function loadConfig() {
    try {
      const cfg = await (await fetch('/api/config')).json();
      const label = cfg.auth ? `${cfg.fhirServer} · Bearer auth ✓` : cfg.fhirServer;
      els.connectionText.textContent = label || 'unknown server';
      els.connectionPill.classList.add(cfg.auth ? 'conn-auth' : 'conn-public');
      els.connectionPill.title = cfg.auth
        ? `Connected to ${cfg.fhirServer} with a Bearer token (kept secret in .env)`
        : `Connected to ${cfg.fhirServer} (no auth required)`;
      els.footerServer.textContent = `FHIR server: ${cfg.fhirServer}${cfg.fhirPath}`;
    } catch {
      els.connectionText.textContent = 'Config unavailable';
      els.connectionPill.classList.add('conn-error');
    }
  }

  // ── Events ──────────────────────────────────────────────────────────────
  els.addPatientBtn.addEventListener('click', openCreateModal);
  els.modalClose.addEventListener('click', closeModal);
  els.cancelBtn.addEventListener('click', closeModal);
  els.errorDismiss.addEventListener('click', () => { els.errorBanner.hidden = true; });

  els.modalOverlay.addEventListener('click', (e) => {
    if (e.target === els.modalOverlay) closeModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.modalOverlay.hidden) closeModal();
  });

  // Edit buttons (event delegation on the table body)
  els.patientsBody.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-patient-id]');
    if (btn) openEditModal(btn.dataset.patientId);
  });

  // Debounced search: queries the FHIR `name:contains` search parameter
  els.searchInput.addEventListener('input', () => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => {
      const q = els.searchInput.value.trim();
      if (q === state.searchQuery) return;
      state.searchQuery = q;
      loadPatients(q);
    }, 350);
  });

  // Clear a field's error as soon as the user fixes it
  for (const key of Object.keys(fieldInputMap)) {
    const input = els[fieldInputMap[key]];
    input.addEventListener('input', () => clearFieldError(key));
    input.addEventListener('change', () => clearFieldError(key));
  }

  els.patientForm.addEventListener('submit', handleSubmit);

  // ── Init ────────────────────────────────────────────────────────────────
  async function init() {
    loadConfig();
    await loadPatients(''); // fetch all patients on load
  }

  init();
})();
