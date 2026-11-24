// Cópia do núcleo do Gym Rats do Anti Janja (antijanja/src/resenha/gym.mjs): mesmo banco gym-data/gym.sqlite.
// Gym Rats do Regresso: 1 check-in por dia (com foto) = 1 ponto. Ranking mensal, sequência 🔥, campeão do mês.
// Banco próprio (gym-data/gym.sqlite), compartilhado com o Zap e o Portal. Pessoa = id do Discord.
// As fotos ficam salvas no servidor (o link do Discord expira), redimensionadas.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import config from './config.js';
const BASE = path.dirname(path.dirname(config.zapDb));

const PASTA = process.env.GYM_DIR || `${BASE}/gym-data`;
export const FOTOS = path.join(PASTA, 'fotos');
fs.mkdirSync(FOTOS, { recursive: true });

const db = new Database(path.join(PASTA, 'gym.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.exec(`
  CREATE TABLE IF NOT EXISTS checkins (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,          -- id do Discord
    nome    TEXT,
    dia     TEXT NOT NULL,          -- AAAA-MM-DD (Brasília)
    quando  TEXT NOT NULL DEFAULT (datetime('now')),
    foto    TEXT,                   -- arquivo em gym-data/fotos
    legenda TEXT,
    origem  TEXT,                   -- discord | zap
    UNIQUE (user_id, dia)
  );
  CREATE TABLE IF NOT EXISTS estado (chave TEXT PRIMARY KEY, valor TEXT);
`);

export const hoje = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const mesDe = dia => dia.slice(0, 7);
const ontem = dia => { const d = new Date(`${dia}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
export const nomeMes = mes => `${MESES[Number(mes.slice(5, 7)) - 1]} de ${mes.slice(0, 4)}`;

async function salvarFoto(buffer) {
    const { default: sharp } = await import('sharp');
    sharp.concurrency(1);
    const arquivo = `${hoje()}-${crypto.randomBytes(6).toString('hex')}.jpg`;
    await sharp(buffer, { animated: false }).rotate().resize({ width: 1080, height: 1080, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 }).toFile(path.join(FOTOS, arquivo));
    return arquivo;
}

// Dias seguidos com treino, terminando hoje (ou ontem, se ainda não treinou hoje)
export function sequencia(userId, dia = hoje()) {
    const dias = new Set(db.prepare('SELECT dia FROM checkins WHERE user_id = ?').all(userId).map(r => r.dia));
    let d = dias.has(dia) ? dia : ontem(dia);
    let n = 0;
    while (dias.has(d)) { n++; d = ontem(d); }
    return n;
}

export function rankingMes(mes = mesDe(hoje())) {
    return db.prepare(`SELECT user_id, MAX(nome) AS nome, COUNT(*) AS pontos, MAX(dia) AS ultimo
        FROM checkins WHERE substr(dia, 1, 7) = ? GROUP BY user_id ORDER BY pontos DESC, ultimo ASC`).all(mes)
        .map((r, i) => ({ ...r, posicao: i + 1, sequencia: sequencia(r.user_id) }));
}

// Registra o treino do dia. Devolve { ok, motivo?, checkin, pontos, posicao, sequencia }
export async function registrar({ userId, nome, foto, legenda, origem }) {
    const dia = hoje();
    if (db.prepare('SELECT 1 FROM checkins WHERE user_id = ? AND dia = ?').get(userId, dia)) {
        return { ok: false, motivo: 'Você já marcou o treino de hoje. Amanhã tem mais! 💪' };
    }
    const arquivo = foto ? await salvarFoto(foto) : null;
    const id = db.prepare('INSERT INTO checkins (user_id, nome, dia, foto, legenda, origem) VALUES (?, ?, ?, ?, ?, ?)')
        .run(userId, nome, dia, arquivo, (legenda || '').slice(0, 200) || null, origem).lastInsertRowid;
    const ranking = rankingMes();
    const eu = ranking.find(r => r.user_id === userId);
    return { ok: true, id, arquivo, pontos: eu.pontos, posicao: eu.posicao, total: ranking.length, sequencia: eu.sequencia };
}

export function apagarHoje(userId) {
    const c = db.prepare('SELECT * FROM checkins WHERE user_id = ? AND dia = ?').get(userId, hoje());
    if (!c) return false;
    db.prepare('DELETE FROM checkins WHERE id = ?').run(c.id);
    if (c.foto) fs.rmSync(path.join(FOTOS, c.foto), { force: true });
    return true;
}

// Campeão do mês que acabou: uma vez, no dia 1 a partir das 9h
export function campeaoPendente(agora = new Date()) {
    const dia = hoje(agora);
    const hora = Number(agora.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false }));
    if (!dia.endsWith('-01') || hora < 9) return null;
    const mesPassado = mesDe(ontem(dia));
    if (db.prepare('SELECT 1 FROM estado WHERE chave = ?').get(`campeao_${mesPassado}`)) return null;
    db.prepare('INSERT OR REPLACE INTO estado (chave, valor) VALUES (?, ?)').run(`campeao_${mesPassado}`, dia);
    const ranking = rankingMes(mesPassado);
    return ranking.length ? { mes: mesPassado, ranking } : null;
}

// ---------- Comandos do Zap: !treino (com foto) · !gym · !apagartreino ----------
import { downloadMediaMessage } from 'baileys';
import { desembrulhar, citada } from './figurinha.js';
import { quemE } from './bancos.js';

export const COMANDOS_GYM = ['treino', 'treinei', 'gym', 'academia', 'apagartreino', 'site'];
// Comandos que funcionam no grupo do Gym Rats (o bot ignora o resto lá)
export const PERMITIDOS_NO_GRUPO_GYM = [...COMANDOS_GYM, 'vincular', 'ajuda', 'help', 'menu'];

// O grupo do Gym Rats é definido por um admin do grupo com !ativargym (fica no banco do gym)
export const grupoGym = () => db.prepare("SELECT valor FROM estado WHERE chave = 'grupo'").get()?.valor ?? null;

export async function ativarGym(sock, msg, ids, config) {
    const chat = msg.key.remoteJid;
    const responder = text => sock.sendMessage(chat, { text }, { quoted: msg });
    if (!chat.endsWith('@g.us')) return responder('Use *!ativargym* dentro do grupo do Gym Rats.');
    if (chat === config.grupoId) return responder('Esse é o grupo do Regresso. O Gym Rats funciona só no grupo do treino.');
    const meta = await sock.groupMetadata(chat).catch(() => null);
    const admin = meta?.participants?.some(p => ids.includes(p.id) || ids.includes(p.phoneNumber) || ids.includes(p.lid) ? Boolean(p.admin) : false);
    if (!admin) return responder('Só admin do grupo pode ativar o Gym Rats aqui.');
    db.prepare("INSERT OR REPLACE INTO estado (chave, valor) VALUES ('grupo', ?)").run(chat);
    return responder('🏋️ *Gym Rats ativado neste grupo!*\nManda a foto do treino com a legenda *!treino* — 1 treino por dia = 1 ponto.\n*!gym* — ranking do mês · *!site* — página com ranking e fotos (com senha)\n\nPra contar ponto, cada um precisa ter o número vinculado ao Discord do Regresso (*!vincular*).');
}

export const AJUDA_GYM = '🏋️ *Gym Rats*\nManda a foto do treino com a legenda *!treino* (dá pra escrever o que treinou: *!treino perna*) — 1 treino por dia = 1 ponto\n*!gym* — ranking do mês e sequências 🔥\n*!apagartreino* — apaga o check-in de hoje\n*!site* — página com ranking e mural de fotos (pede a senha do grupo)';

// Campeão do mês no grupo do Gym Rats (dia 1, 9h)
export async function anunciarCampeao(sock) {
    const grupo = grupoGym();
    if (!grupo) return;
    const c = campeaoPendente();
    if (!c) return;
    const top = c.ranking.slice(0, 5).map(r => `${r.posicao <= 3 ? ['🥇', '🥈', '🥉'][r.posicao - 1] : `${r.posicao}.`} *${r.nome}* — ${r.pontos} treinos`).join('\n');
    await sock.sendMessage(grupo, { text: `🏆 *Gym Rats de ${nomeMes(c.mes)}*\nCampeão: *${c.ranking[0].nome}* com ${c.ranking[0].pontos} treinos!\n\n${top}\n\nO ranking zerou: bora pro mês novo 💪` });
}

export async function tratarGym(sock, msg, ids, texto) {
    const chat = msg.key.remoteJid;
    const responder = text => sock.sendMessage(chat, { text }, { quoted: msg });
    const cmd = texto.trim().slice(1).split(/\s+/)[0].toLowerCase();
    const v = quemE(ids);

    if (cmd === 'site') return responder('🌐 https://regresso.mrbnexus.com.br/gym\nA senha é a do grupo (pergunta pro Maique).');
    if (cmd === 'gym' || cmd === 'academia') {
        const r = rankingMes();
        const linhas = r.slice(0, 15).map(x => `${x.posicao <= 3 ? ['🥇', '🥈', '🥉'][x.posicao - 1] : `${x.posicao}.`} *${x.nome}* — ${x.pontos}${x.sequencia >= 2 ? ` · 🔥${x.sequencia}` : ''}`);
        return responder(`🏋️ *Gym Rats — ${nomeMes(hoje().slice(0, 7))}*\n${linhas.join('\n') || 'Ninguém treinou ainda este mês. Manda a foto com *!treino* 💪'}\n\n1 treino por dia = 1 ponto`);
    }
    if (!v) return responder('Pra entrar no Gym Rats, vincule seu Discord: use /zap no Discord e mande *!vincular CÓDIGO* aqui.');
    if (cmd === 'apagartreino') return responder(apagarHoje(v.discord_id) ? '🗑️ Check-in de hoje apagado.' : 'Você não tem check-in hoje.');

    const propria = desembrulhar(msg.message);
    const alvo = propria?.imageMessage ? { ...msg, message: propria } : citada(msg);
    if (!alvo?.message?.imageMessage) return responder('📸 Manda a *foto do treino* com a legenda *!treino* (pode escrever o que treinou depois: *!treino perna*).');
    try {
        const foto = await downloadMediaMessage(alvo, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
        const legenda = texto.trim().replace(/^\S+\s*/, '');
        const res = await registrar({ userId: v.discord_id, nome: v.nome, foto, legenda, origem: 'zap' });
        if (!res.ok) return responder(res.motivo);
        return responder(`💪 *${v.nome}* treinou! ${res.pontos} ponto${res.pontos > 1 ? 's' : ''} no mês · ${res.posicao}º de ${res.total}${res.sequencia >= 2 ? ` · 🔥 ${res.sequencia} dias seguidos` : ''}`);
    } catch (e) {
        console.error('Gym Rats:', e.message);
        return responder('⚠️ Não consegui salvar a foto do treino. Tenta de novo.');
    }
}
