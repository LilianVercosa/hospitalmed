<?php
/**
 * Ponte entre a isca "Quanto realmente sobra" e o Kommo.
 *
 * O token do Kommo fica AQUI, no servidor (Hostinger), e nunca aparece
 * para quem acessa a página. Suba este arquivo na MESMA pasta do index.html.
 *
 * O que ele faz:
 *  1) step = "lead"   → cria o lead + contato (nome e WhatsApp) no Kommo, com tags.
 *  2) step = "result" → adiciona uma nota no lead com o resultado da calculadora.
 *     Se o lead ainda não existir (o primeiro envio falhou), cria e já anota.
 */

/* ======================= CONFIGURAÇÃO ======================= */
// Subdomínio da sua conta: se você acessa https://lilianvercosa.kommo.com, use 'lilianvercosa'
const KOMMO_SUBDOMAIN = 'contatovercosacontabilidadecombr';

// Token de longa duração (Kommo > Configurações > Integrações > Criar integração privada > Chaves e escopos)
const KOMMO_TOKEN = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIsImp0aSI6IjM2YjI1MTM2MWQyZGVhYzllZmQ2YWIyYmRhZTI3ZDU3ZjQ2ZDUxZTQzZWY2ZTVlYWM2ZGI2ZjNjODg2ZGNiM2ExNTNjMWUzOWMyYWVjMjNlIn0.eyJhdWQiOiI1ZGVkMzE3NC04NTA1LTRhZTAtYjljNi04OGRhYTUxZGExNDciLCJqdGkiOiIzNmIyNTEzNjFkMmRlYWM5ZWZkNmFiMmJkYWUyN2Q1N2Y0NmQ1MWU0M2VmNmU1ZWFjNmRiNmYzYzg4NmRjYjNhMTUzYzFlMzljMmFlYzIzZSIsImlhdCI6MTc4ODY0ODc4NiwibmJmIjoxNzg4NjQ4Nzg2LCJleHAiOjE4OTYwNDgwMDAsInN1YiI6IjE0NTY3NzQzIiwiZ3JhbnRfdHlwZSI6IiIsImFjY291bnRfaWQiOjM1ODcxMzY3LCJiYXNlX2RvbWFpbiI6ImtvbW1vLmNvbSIsInZlcnNpb24iOjIsInNjb3BlcyI6WyJjcm0iLCJmaWxlcyIsImZpbGVzX2RlbGV0ZSIsIm5vdGlmaWNhdGlvbnMiLCJwdXNoX25vdGlmaWNhdGlvbnMiXSwiaGFzaF91dWlkIjoiYzc0NTkyYzItMWQ5Ny00ZGIwLTk3NTYtMmY3ZTA3NDlhODUxIiwiYXBpX2RvbWFpbiI6ImFwaS1jLmtvbW1vLmNvbSJ9.UtGnOl_YINV2mIaHpU8F4jv0pCz89clBpKxHasnSusmgh7eOhuvz0fmtUnLUxl_0uLiwxo2yINsbnpwbXZ9wmnvcS9mZzbQOv3zZ4KbaYcPlneAZpV6rmLdqKBjI1mn7JHFOE2IlXERHVmlW1Evx0_SNvTNF2Fk93zUm4aDs0MSsyoxwPLfnm_ekoaf05-xVeIMGZLkEYygHx0z5DA2fnijs-IvAQJp3XrOHRbeaVM4F4KyExPzKpHJ202MtsRNvgmwQKb58Doxqjs6PuvgCZy76rKToksLptOl9IcPGsYHjjrvz9ZEeOVmmpgLcsE0eP9QzBgXHx-WycEu0UP1QTA';

// Pipeline (funil) onde o lead deve entrar, pelo NOME como aparece no Kommo.
// Maiúsculas, acentos e espaços não importam ("Hospital Med", "HospitalMed" e "hospital med" funcionam).
const KOMMO_PIPELINE_NAME = 'Hospital Med';

// Se preferir fixar pelo ID, preencha aqui (tem prioridade sobre o nome). 0 = usar o nome acima.
const KOMMO_PIPELINE_ID = 14592019; // Hospital Med
// Etapa dentro da pipeline. 0 = primeira etapa.
const KOMMO_STATUS_ID   = 0;

// Tag fixa que identifica a origem do lead
const LEAD_TAG = 'hospitalmed';

// OPCIONAL: campos personalizados do LEAD no Kommo (tipo "Número").
// Os valores SEMPRE vão numa nota do lead. Se você também quiser que fiquem em
// campos próprios (pra filtrar no funil), crie os campos no Kommo e cole o ID de cada um.
// Deixe 0 nos que não quiser usar.
const KOMMO_FIELDS = [
    'faturamento' => 0, // Quanto entrou no mês
    'variaveis'   => 0, // Custos que variam com o movimento
    'impostos'    => 0, // Impostos pagos no mês
    'fixos'       => 0, // Custos fixos (sem equipe)
    'folha'       => 0, // Folha da equipe
    'prolabore'   => 0, // Pró-labore
    'margem'      => 0, // Margem (%)
    'taxShare'    => 0, // Imposto sobre faturamento (%)
    'fatorR'      => 0, // Fator R estimado (%)
];
/* ============================================================ */

header('Content-Type: application/json; charset=utf-8');

function respond($code, $data) {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(405, ['ok' => false, 'error' => 'method']);
}

$in = json_decode(file_get_contents('php://input'), true);
if (!is_array($in)) {
    respond(400, ['ok' => false, 'error' => 'json']);
}

/* ---------- Validação dos dados ---------- */
$name = trim(strip_tags((string)($in['name'] ?? '')));
$name = mb_substr($name, 0, 80);
$phone = preg_replace('/\D/', '', (string)($in['phone'] ?? ''));
$segmentsAllowed = ['Dono(a) ou sócio(a) de clínica', 'Gestor(a)', 'Profissional PJ', 'Contador(a) ou consultor(a)', 'Fornecedor', 'Outro'];
$contabAllowed = ['Sim', 'Não', 'Não sei'];
$contab = in_array($in['contab'] ?? '', $contabAllowed, true) ? $in['contab'] : 'Não informado';
$segment = in_array($in['segment'] ?? '', $segmentsAllowed, true) ? $in['segment'] : 'Outro';
$step = ($in['step'] ?? '') === 'result' ? 'result' : 'lead';

if (mb_strlen($name) < 2 || strlen($phone) < 10 || strlen($phone) > 11) {
    respond(400, ['ok' => false, 'error' => 'dados']);
}
$phoneE164 = '+55' . $phone;

$segmentTag = [
    'Dono(a) ou sócio(a) de clínica' => 'dono-clinica',
    'Gestor(a)'                      => 'gestor',
    'Profissional PJ'                => 'pj-saude',
    'Contador(a) ou consultor(a)'    => 'contador',
    'Fornecedor'                     => 'fornecedor',
    'Outro'                          => 'outro',
][$segment];
$contabTag = [
    'Sim'           => 'contab-saude-sim',
    'Não'           => 'contab-saude-nao',
    'Não sei'       => 'contab-saude-nao-sabe',
    'Não informado' => null,
][$contab];

/* ---------- Chamada à API do Kommo ---------- */
function kommo($method, $path, $body = null) {
    $ch = curl_init('https://' . KOMMO_SUBDOMAIN . '.kommo.com' . $path);
    $opts = [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CUSTOMREQUEST  => $method,
        CURLOPT_TIMEOUT        => 12,
        CURLOPT_HTTPHEADER     => [
            'Authorization: Bearer ' . KOMMO_TOKEN,
            'Content-Type: application/json',
        ],
    ];
    if ($body !== null) {
        $opts[CURLOPT_POSTFIELDS] = json_encode($body, JSON_UNESCAPED_UNICODE);
    }
    curl_setopt_array($ch, $opts);
    $raw  = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err  = curl_error($ch);
    curl_close($ch);
    if ($code >= 300 || $raw === false) {
        error_log("[isca-kommo] $method $path → HTTP $code $err " . substr((string)$raw, 0, 500));
    }
    return [$code, json_decode((string)$raw, true)];
}

// Descobre o ID da pipeline pelo nome (guarda em cache por 12h pra não consultar toda vez)
function normalizeName($s) {
    $s = mb_strtolower(trim($s));
    $s = strtr($s, ['á'=>'a','à'=>'a','â'=>'a','ã'=>'a','é'=>'e','ê'=>'e','í'=>'i','ó'=>'o','ô'=>'o','õ'=>'o','ú'=>'u','ç'=>'c']);
    return preg_replace('/[^a-z0-9]/', '', $s);
}
function resolvePipelineId() {
    if (KOMMO_PIPELINE_ID) return (int)KOMMO_PIPELINE_ID;
    if (!KOMMO_PIPELINE_NAME) return 0;
    $cacheFile = sys_get_temp_dir() . '/isca-kommo-pipeline-' . md5(KOMMO_SUBDOMAIN . KOMMO_PIPELINE_NAME) . '.txt';
    if (is_file($cacheFile) && time() - filemtime($cacheFile) < 43200) {
        return (int)file_get_contents($cacheFile);
    }
    [$code, $data] = kommo('GET', '/api/v4/leads/pipelines');
    $wanted = normalizeName(KOMMO_PIPELINE_NAME);
    foreach (($data['_embedded']['pipelines'] ?? []) as $p) {
        if (normalizeName($p['name'] ?? '') === $wanted) {
            @file_put_contents($cacheFile, (string)$p['id']);
            return (int)$p['id'];
        }
    }
    error_log('[isca-kommo] pipeline "' . KOMMO_PIPELINE_NAME . '" não encontrada; lead vai para o funil principal');
    return 0;
}

// Assinatura simples: só quem criou o lead nesta página consegue anotar nele depois
function signLead($id) {
    return hash_hmac('sha256', 'lead-' . $id, KOMMO_TOKEN);
}

/* ---------- 1) Cria o lead (ou reaproveita o já criado) ---------- */
$leadId = (int)($in['leadId'] ?? 0);
$token  = (string)($in['token'] ?? '');
if ($leadId && !hash_equals(signLead($leadId), $token)) {
    $leadId = 0; // ID não confere: não confia nele, cria um novo
}

if (!$leadId) {
    $leadPayload = [
        'name' => 'HospitalMed · ' . $name,
        '_embedded' => [
            'tags' => array_values(array_filter([
                ['name' => LEAD_TAG],
                ['name' => 'isca-quanto-sobra'],
                ['name' => $segmentTag],
                $contabTag ? ['name' => $contabTag] : null,
            ])),
            'contacts' => [[
                'name' => $name,
                'custom_fields_values' => [[
                    'field_code' => 'PHONE',
                    'values' => [['value' => $phoneE164, 'enum_code' => 'WORK']],
                ]],
            ]],
        ],
    ];
    $pipelineId = resolvePipelineId();
    if ($pipelineId)      $leadPayload['pipeline_id'] = $pipelineId;
    if (KOMMO_STATUS_ID)  $leadPayload['status_id']   = KOMMO_STATUS_ID;

    [$code, $data] = kommo('POST', '/api/v4/leads/complex', [$leadPayload]);
    if ($code >= 300 || empty($data[0]['id'])) {
        respond(502, ['ok' => false, 'error' => 'kommo-lead']);
    }
    $leadId = (int)$data[0]['id'];

    $note = "Lead da HospitalMed (calculadora \"Quanto realmente sobra na clínica\").\n"
          . "Nome: $name\nWhatsApp: $phoneE164\nPerfil: $segment\n"
          . "Contabilidade especializada em saúde: $contab";
    kommo('POST', "/api/v4/leads/$leadId/notes", [[
        'note_type' => 'common',
        'params'    => ['text' => $note],
    ]]);
}

/* ---------- 2) Anota o resultado da calculadora ---------- */
if ($step === 'result' && is_array($in['result'] ?? null)) {
    $r = $in['result'];
    $num = function ($k) use ($r) { return isset($r[$k]) && is_numeric($r[$k]) ? (float)$r[$k] : null; };
    $brl = function ($v) { return $v === null ? '—' : 'R$ ' . number_format($v, 2, ',', '.'); };
    $pc  = function ($v) { return $v === null ? '—' : number_format($v, 1, ',', '.') . '%'; };
    $txt = function ($k) use ($r) { return mb_substr(trim(strip_tags((string)($r[$k] ?? ''))), 0, 120); };

    $note = "RESULTADO DA CALCULADORA\n"
          . "Margem: " . $pc($num('margem')) . " (" . ($txt('faixa') ?: '—') . ")\n"
          . "Faturamento no mês: " . $brl($num('faturamento')) . "\n"
          . "Custos variáveis: " . $brl($num('variaveis')) . "\n"
          . "Impostos: " . $brl($num('impostos')) . " (" . $pc($num('taxShare')) . " do faturamento)\n"
          . "Custos fixos: " . $brl($num('fixos')) . "\n"
          . "Folha da equipe: " . $brl($num('folha')) . "\n"
          . "Pró-labore: " . $brl($num('prolabore')) . "\n"
          . "Fator R estimado: " . $pc($num('fatorR')) . "\n"
          . "Alerta: " . ($txt('alerta') ?: 'nenhum');

    kommo('POST', "/api/v4/leads/$leadId/notes", [[
        'note_type' => 'common',
        'params'    => ['text' => $note],
    ]]);

    // Preenche os campos personalizados configurados (se houver)
    $cf = [];
    foreach (KOMMO_FIELDS as $key => $fieldId) {
        $v = $num($key);
        if ($fieldId && $v !== null) {
            $cf[] = ['field_id' => (int)$fieldId, 'values' => [['value' => round($v, 2)]]];
        }
    }
    if ($cf) {
        $patch = ['custom_fields_values' => $cf];
        if ($num('faturamento') !== null) $patch['price'] = (int)round($num('faturamento'));
        kommo('PATCH', "/api/v4/leads/$leadId", $patch);
    }
}

respond(200, ['ok' => true, 'leadId' => $leadId, 'token' => signLead($leadId)]);
