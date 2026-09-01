import { ref, onMounted } from 'vue';

// Every request is relative: the browser only ever talks to the origin that
// served the page. nginx (or Vite in development) relays /api to the backend,
// which is not reachable from the internet at all.
export async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    const err = new Error(body?.error?.message || `HTTP ${res.status}`);
    err.code = body?.error?.code;
    throw err;
  }

  return body;
}

// The API answers with a stable machine code; the interface owns the wording
// and the language. Translating server-side would make the display language
// part of the API contract, which a second locale or a mobile client would
// immediately have to work around.
const ERROR_LABELS = {
  unknown_account: 'Compte introuvable.',
  unknown_beneficiary: 'Bénéficiaire introuvable.',
  invalid_amount: 'Montant invalide.',
  insufficient_funds: 'Solde insuffisant pour ce virement.',
  invalid_json: 'Requête invalide.',
  not_found: 'Ressource introuvable.',
  internal_error: 'Erreur interne du service.'
};

// A fetch that never reached the backend throws without a code: that is the
// backend-is-down case, and it deserves its own wording.
export const errorLabel = (e) =>
  ERROR_LABELS[e?.code] || 'Service momentanément indisponible.';

// The API speaks integer cents. Converting to euros is a display concern and
// happens here only.
export const euro = (cents) =>
  new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format((cents || 0) / 100);

export const frenchDate = (iso) =>
  new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short' }).format(new Date(iso));

// Loads a resource on mount and exposes loading/error state, so no view has to
// reimplement the same three-state dance. The error state is not decoration:
// it is what the user sees when the backend is down, and it is the visible
// half of the resilience story.
export function useResource(loader) {
  const data = ref(null);
  const error = ref(null);
  const loading = ref(true);
  const instance = ref(null);

  async function reload() {
    loading.value = true;
    error.value = null;
    try {
      const body = await loader();
      data.value = body.data;
      instance.value = body.meta?.instance ?? null;
    } catch (e) {
      error.value = errorLabel(e);
      data.value = null;
    } finally {
      loading.value = false;
    }
  }

  onMounted(reload);

  return { data, error, loading, instance, reload };
}
