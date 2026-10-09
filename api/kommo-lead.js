// Envia os leads da isca HospitalMed para a pipeline Hospital Med no Kommo.
// Variáveis de ambiente na Vercel (Settings > Environment Variables):
//   KOMMO_TOKEN      -> token de longa duração do Kommo (obrigatório)
//   KOMMO_SUBDOMAIN  -> contatovercosacontabilidadecombr (opcional, já tem padrão abaixo)
import crypto from 'crypto';

const PIPELINE_ID = 14592019; // Pipeline: Hospital Med
const STATUS_ID = null;       // null = primeira etapa da pipeline
const DEFAULT_SUBDOMAIN = 'contatovercosacontabilidadecombr';

// OPCIONAL: IDs de campos personalizados do lead (tipo Número) criados no Kommo
const FIELD_MARGEM = null;
const FIELD_FATURAMENTO = null;
const FIELD_IMPOSTO_PCT = null;
const FIELD_FATOR_R = null;

const SEGMENT_TAGS = {
  'Dono(a) ou sócio(a) de clínica': 'dono-clinica',
  'Gestor(a)': 'gestor',
  'Profissional PJ': 'pj-saude',
  'Contador(a) ou consultor(a)': 'contador',
  'Fornecedor': 'fornecedor',
  'Outro': 'outro',
};
const CONTAB_TAGS = { 'Sim': 'contab-saude-sim', 'Não': 'contab-saude-nao', 'Não sei': 'contab-saude-nao-sabe' };

/* ---------- utilitários ---------- */
const clean = (v, max = 120) => String(v ?? '').replace(/<[^>]*>/g, '').trim().slice(0, max);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const brl = (v) => (v == null ? '—' : 'R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const pct = (v) => (v == null ? '—' : v.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%');
const sign = (token, id) => crypto.createHmac('sha256', token).update('lead-' + id).digest('hex');

async function kommo(subdomain, token, method, path, body) {
  try {
    const res = await fetch(`https://${subdomain}.kommo.com${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) console.error(`Kommo ${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    console.error(`Kommo ${method} ${path} falhou:`, err);
    return { ok: false, status: 0, data: null };
  }
}

function addNote(subdomain, token, leadId, text) {
  return kommo(subdomain, token, 'POST', `/api/v4/leads/${leadId}/notes`, [{ note_type: 'common', params: { text } }]);
}

async function addTagToLead(subdomain, token, leadId, tagName) {
  const got = await kommo(subdomain, token, 'GET', `/api/v4/leads/${leadId}`);
  if (!got.ok) return;
  const existing = got.data?._embedded?.tags || [];
  if (existing.some((t) => t.name === tagName)) return;
  await kommo(subdomain, token, 'PATCH', `/api/v4/leads/${leadId}`, {
    _embedded: { tags: [...existing.map((t) => ({ id: t.id })), { name: tagName }] },
  });
}

/* ---------- handler ---------- */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  const token = process.env.KOMMO_TOKEN;
  const subdomain = process.env.KOMMO_SUBDOMAIN || DEFAULT_SUBDOMAIN;
  if (!token) {
    console.error('KOMMO_TOKEN não configurado na Vercel');
    res.status(500).json({ ok: false, error: 'Integração não configurada' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  body = body || {};

  const name = clean(body.name, 80);
  const phone = String(body.phone || '').replace(/\D/g, '');
  const segment = SEGMENT_TAGS[body.segment] ? body.segment : 'Outro';
  const contab = CONTAB_TAGS[body.contab] ? body.contab : 'Não informado';
  const isResult = body.step === 'result' && body.result && typeof body.result === 'object';

  if (name.length < 2 || phone.length < 10 || phone.length > 11) {
    res.status(400).json({ ok: false, error: 'Nome e WhatsApp válidos são obrigatórios' });
    return;
  }
  const phoneE164 = '+55' + phone;

  try {
    // 1) Reaproveita o lead criado na qualificação (só se a assinatura conferir)
    let leadId = parseInt(body.leadId, 10) || 0;
    if (leadId) {
      const given = String(body.token || '');
      const expected = sign(token, leadId);
      const valid = given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
      if (!valid) leadId = 0;
    }

    // 2) Lead novo: cria na pipeline Hospital Med
    if (!leadId) {
      const tags = [{ name: 'hospitalmed' }, { name: 'isca-quanto-sobra' }, { name: SEGMENT_TAGS[segment] }];
      if (CONTAB_TAGS[contab]) tags.push({ name: CONTAB_TAGS[contab] });

      const leadPayload = {
        name: `HospitalMed · ${name}`,
        pipeline_id: PIPELINE_ID,
        ...(STATUS_ID ? { status_id: STATUS_ID } : {}),
        _embedded: {
          tags,
          contacts: [{
            name,
            custom_fields_values: [{ field_code: 'PHONE', values: [{ value: phoneE164, enum_code: 'WORK' }] }],
          }],
        },
      };

      const created = await kommo(subdomain, token, 'POST', '/api/v4/leads/complex', [leadPayload]);
      // O endpoint /leads/complex devolve uma lista: [{ id, contact_id, ... }]
      leadId = created.data?.[0]?.id || created.data?._embedded?.leads?.[0]?.id || 0;
      if (!created.ok || !leadId) {
        res.status(502).json({ ok: false, error: 'Falha ao enviar para o Kommo' });
        return;
      }

      await addNote(subdomain, token, leadId, [
        'Lead da HospitalMed (calculadora "Quanto realmente sobra na clínica").',
        `Nome: ${name}`,
        `WhatsApp: ${phoneE164}`,
        `Perfil: ${segment}`,
        `Contabilidade especializada em saúde: ${contab}`,
        isResult ? '' : 'Ainda não concluiu o cálculo.',
      ].filter(Boolean).join('\n'));
    }

    // 3) Resultado da calculadora: nota + valor do lead + campos + tag de imposto alto
    if (isResult) {
      const r = body.result;
      const faturamento = num(r.faturamento);
      const margem = num(r.margem);
      const taxShare = num(r.taxShare);
      const fatorR = num(r.fatorR);
      const alerta = clean(r.alerta);

      await addNote(subdomain, token, leadId, [
        'RESULTADO DA CALCULADORA',
        `Margem: ${pct(margem)} (${clean(r.faixa) || '—'})`,
        `Faturamento no mês: ${brl(faturamento)}`,
        `Custos variáveis: ${brl(num(r.variaveis))}`,
        `Impostos: ${brl(num(r.impostos))} (${pct(taxShare)} do faturamento)`,
        `Custos fixos: ${brl(num(r.fixos))}`,
        `Folha da equipe: ${brl(num(r.folha))}`,
        `Pró-labore: ${brl(num(r.prolabore))}`,
        `Fator R estimado: ${pct(fatorR)}`,
        `Alerta: ${alerta || 'nenhum'}`,
      ].join('\n'));

      const customFields = [];
      if (FIELD_MARGEM && margem != null) customFields.push({ field_id: FIELD_MARGEM, values: [{ value: margem }] });
      if (FIELD_FATURAMENTO && faturamento != null) customFields.push({ field_id: FIELD_FATURAMENTO, values: [{ value: faturamento }] });
      if (FIELD_IMPOSTO_PCT && taxShare != null) customFields.push({ field_id: FIELD_IMPOSTO_PCT, values: [{ value: taxShare }] });
      if (FIELD_FATOR_R && fatorR != null) customFields.push({ field_id: FIELD_FATOR_R, values: [{ value: fatorR }] });

      const patch = {};
      if (faturamento != null) patch.price = Math.round(faturamento);
      if (customFields.length) patch.custom_fields_values = customFields;
      if (Object.keys(patch).length) await kommo(subdomain, token, 'PATCH', `/api/v4/leads/${leadId}`, patch);

      if (alerta.startsWith('Imposto alto')) await addTagToLead(subdomain, token, leadId, 'Imposto alto');
    }

    res.status(200).json({ ok: true, leadId, token: sign(token, leadId) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'Erro interno' });
  }
}
