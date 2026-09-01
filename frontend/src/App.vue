<script setup>
import { ref, computed } from 'vue';
import { api, useResource, euro, frenchDate, errorLabel } from './api';

const accounts = useResource(() => api('/api/accounts'));
const transactions = useResource(() => api('/api/transactions'));
const beneficiaries = useResource(() => api('/api/beneficiaries'));

// Which replica answered the last request. Proves horizontal scaling from the
// client side, without trusting the platform's own reporting.
const instance = computed(() => accounts.instance.value);

const form = ref({ fromAccountId: '', beneficiaryId: '', amountEuros: '' });
const submitting = ref(false);
const formError = ref(null);
const formSuccess = ref(null);

async function submitTransfer() {
  formError.value = null;
  formSuccess.value = null;

  // Parsed to integer cents here, so the API never sees a float.
  const amountCents = Math.round(Number(form.value.amountEuros) * 100);

  submitting.value = true;
  try {
    const body = await api('/api/transfers', {
      method: 'POST',
      body: JSON.stringify({
        fromAccountId: form.value.fromAccountId,
        beneficiaryId: form.value.beneficiaryId,
        amountCents
      })
    });
    formSuccess.value = `Virement de ${euro(-body.data.transaction.amountCents)} enregistré.`;
    form.value.amountEuros = '';
    // The balance and the history both changed server-side; refetch rather
    // than patching local state, which would drift from the server.
    await Promise.all([accounts.reload(), transactions.reload()]);
  } catch (e) {
    formError.value = errorLabel(e);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <header>
    <h1>Espace Client</h1>
  </header>

  <main>
    <section>
      <h2>Mes comptes</h2>
      <p v-if="accounts.loading.value" class="state">Chargement…</p>
      <p v-else-if="accounts.error.value" class="state error">
        {{ accounts.error.value }}
        <button type="button" @click="accounts.reload()">Réessayer</button>
      </p>
      <ul v-else class="accounts">
        <li v-for="a in accounts.data.value" :key="a.id">
          <span>
            <strong>{{ a.label }}</strong>
            <em>{{ a.number }}</em>
          </span>
          <b>{{ euro(a.balanceCents) }}</b>
        </li>
      </ul>
    </section>

    <section>
      <h2>Dernières opérations</h2>
      <p v-if="transactions.loading.value" class="state">Chargement…</p>
      <p v-else-if="transactions.error.value" class="state error">
        {{ transactions.error.value }}
        <button type="button" @click="transactions.reload()">Réessayer</button>
      </p>
      <ul v-else class="transactions">
        <li v-for="t in transactions.data.value" :key="t.id">
          <span>
            <strong>{{ t.label }}</strong>
            <em>{{ frenchDate(t.date) }}</em>
          </span>
          <b :class="t.amountCents < 0 ? 'debit' : 'credit'">{{ euro(t.amountCents) }}</b>
        </li>
      </ul>
    </section>

    <section>
      <h2>Nouveau virement</h2>
      <form @submit.prevent="submitTransfer">
        <label>
          Depuis
          <select v-model="form.fromAccountId" required>
            <option value="" disabled>Choisir un compte</option>
            <option v-for="a in accounts.data.value || []" :key="a.id" :value="a.id">
              {{ a.label }} — {{ euro(a.balanceCents) }}
            </option>
          </select>
        </label>

        <label>
          Vers
          <select v-model="form.beneficiaryId" required>
            <option value="" disabled>Choisir un bénéficiaire</option>
            <option v-for="b in beneficiaries.data.value || []" :key="b.id" :value="b.id">
              {{ b.name }}
            </option>
          </select>
        </label>

        <label>
          Montant (€)
          <input v-model="form.amountEuros" type="number" min="0.01" step="0.01" required />
        </label>

        <button type="submit" :disabled="submitting">
          {{ submitting ? 'Envoi…' : 'Valider le virement' }}
        </button>
      </form>

      <p v-if="formError" class="state error">{{ formError }}</p>
      <p v-if="formSuccess" class="state success">{{ formSuccess }}</p>
    </section>
  </main>

  <footer v-if="instance">Servi par le réplica <code>{{ instance }}</code></footer>
</template>

<style>
:root {
  --red: #e9041e;
  --ink: #1a1a1a;
  --muted: #6b7280;
  --line: #e5e7eb;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--ink);
  background: #f7f7f8;
}
header {
  background: var(--ink);
  color: #fff;
  padding: 18px 24px;
  border-bottom: 3px solid var(--red);
}
header h1 { margin: 0; font-size: 18px; letter-spacing: 0.02em; }
main {
  max-width: 720px;
  margin: 24px auto;
  padding: 0 16px;
  display: grid;
  gap: 20px;
}
section {
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 18px 20px;
}
h2 { margin: 0 0 12px; font-size: 14px; text-transform: uppercase; color: var(--muted); letter-spacing: 0.05em; }
ul { list-style: none; margin: 0; padding: 0; }
li {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--line);
}
li:last-child { border-bottom: 0; }
li span { display: flex; flex-direction: column; }
li em { font-style: normal; color: var(--muted); font-size: 13px; }
li b { font-variant-numeric: tabular-nums; white-space: nowrap; }
.debit { color: var(--ink); }
.credit { color: #047857; }
form { display: grid; gap: 12px; }
label { display: grid; gap: 4px; font-size: 13px; color: var(--muted); }
select, input {
  font: inherit;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #fff;
}
button {
  font: inherit;
  padding: 9px 14px;
  border: 0;
  border-radius: 6px;
  background: var(--red);
  color: #fff;
  cursor: pointer;
}
button:disabled { background: var(--muted); cursor: default; }
.state { color: var(--muted); margin: 8px 0 0; }
.state.error { color: var(--red); }
.state.success { color: #047857; }
.state button { margin-left: 8px; padding: 4px 10px; font-size: 13px; }
footer {
  max-width: 720px;
  margin: 0 auto 32px;
  padding: 0 16px;
  color: var(--muted);
  font-size: 12px;
}
code { background: #eceff3; padding: 1px 5px; border-radius: 4px; }
</style>
