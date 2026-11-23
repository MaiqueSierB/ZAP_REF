// Bot de Telegram do Regresso: reserva oficial do Zap (API do Telegram, sem risco de ban).
// Usa os MESMOS comandos e bancos do Zap — quem vincula com !vincular no Telegram é a mesma pessoa do Discord.
//   Token: arquivo /home/u243267678/domains/mrbnexus.com.br/.telegram.env com TELEGRAM_TOKEN=...
//   No grupo: /avisos (admin) define onde saem os gols do time de cada um.
// Comandos aceitam "/" (jeito do Telegram) ou "!" (jeito do Zap).
import fs from 'node:fs';
import { tratar } from './comandos.js';
import * as b from './bancos.js';
import { tratarRoleta } from './roleta.js';
import { lerEnquete } from './enquete.js';
import { tratarWrapped } from './wrapped.js';
import { gifDoGol } from './golgif.js';

const BASE = process.env.BOTS_DIR || '/home/u243267678/domains/mrbnexus.com.br';
const ARQUIVO_TOKEN = process.env.TELEGRAM_SECRETS || `${BASE}/.telegram.env`;

function lerToken() {
    if (process.env.TELEGRAM_TOKEN) return process.env.TELEGRAM_TOKEN;
    try {
        return fs.readFileSync(ARQUIVO_TOKEN, 'utf8').match(/^\s*TELEGRAM_TOKEN\s*=\s*"?([^"\s]+)"?/m)?.[1] ?? null;
    } catch {
        return null;
    }
}

let token = null;
let eu = null;   // { id, username } do bot

async function api(metodo, corpo) {
    const ehForm = corpo instanceof FormData;
    const r = await fetch(`https://api.telegram.org/bot${token}/${metodo}`, {
        method: 'POST',
        headers: ehForm ? undefined : { 'Content-Type': 'application/json' },
        body: ehForm ? corpo : JSON.stringify(corpo ?? {}),
        signal: AbortSignal.timeout(metodo === 'getUpdates' ? 65_000 : 30_000)
    });
    const j = await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }));
    if (!j.ok) {
        const e = new Error(j.description || `Telegram respondeu ${r.status}`);
        e.codigo = j.error_code ?? r.status;
        throw e;
    }
    return j.result;
}

// O Zap formata com *negrito* e _itálico_, que o Markdown do Telegram também entende; se der erro, manda sem formatação
async function enviarTexto(chatId, texto, extra = {}) {
    try {
        return await api('sendMessage', { chat_id: chatId, text: texto, parse_mode: 'Markdown', disable_web_page_preview: true, ...extra });
    } catch (e) {
        if (e.codigo !== 400) throw e;
        return api('sendMessage', { chat_id: chatId, text: texto.replace(/[*_~`]/g, ''), disable_web_page_preview: true, ...extra });
    }
}

// "jid" no formato que o código do Zap entende: grupo termina em @g.us, privado em @tg
const jidDe = chat => `${chat.id}@${chat.type === 'private' ? 'tg' : 'g.us'}`;
const chatDe = jid => jid.split('@')[0];

// Imita o pedaço do "sock" do WhatsApp que a roleta e o Wrapped usam
const sockTelegram = {
    async sendMessage(jid, conteudo, opcoes = {}) {
        const chat_id = chatDe(jid);
        const responder = opcoes.quoted?.tgId ? { reply_to_message_id: opcoes.quoted.tgId, allow_sending_without_reply: true } : {};
        if (conteudo.edit) {
            await api('editMessageText', { chat_id, message_id: Number(conteudo.edit.id), text: conteudo.text, parse_mode: 'Markdown' })
                .catch(() => api('editMessageText', { chat_id, message_id: Number(conteudo.edit.id), text: conteudo.text.replace(/[*_~`]/g, '') }));
            return { key: conteudo.edit };
        }
        if (conteudo.image) {
            const f = new FormData();
            f.append('chat_id', chat_id);
            f.append('photo', new Blob([conteudo.image], { type: 'image/png' }), 'imagem.png');
            if (conteudo.caption) { f.append('caption', conteudo.caption.slice(0, 1024)); f.append('parse_mode', 'Markdown'); }
            const m = await api('sendPhoto', f).catch(() => enviarTexto(chat_id, conteudo.caption ?? ''));
            return { key: { id: String(m.message_id), remoteJid: jid } };
        }
        const m = await enviarTexto(chat_id, conteudo.text ?? '', responder);
        return { key: { id: String(m.message_id), remoteJid: jid } };
    }
};

const COMANDOS_SEM_TELEGRAM = ['f', 'fig', 'figurinha', 'sticker', 's', 'print', 'citar', 'quote', 'transmitir', 'live', 'parar'];

async function tratarMensagem(m) {
    const bruto = (m.text ?? m.caption ?? '').trim();
    if (!/^[!/]/.test(bruto)) return;
    // "/comando@NomeDoBot args" → "!comando args"
    let texto = '!' + bruto.slice(1).replace(/^(\S+?)@\w+/, '$1');
    if (/^!start\b/i.test(texto)) texto = '!ajuda';
    const cmd = texto.slice(1).split(/\s+/)[0].toLowerCase();
    const jid = jidDe(m.chat);
    const ids = [`tg:${m.from.id}`];
    const nome = [m.from.first_name, m.from.last_name].filter(Boolean).join(' ') || m.from.username || 'Alguém';
    const msg = { key: { remoteJid: jid }, tgId: m.message_id };
    const grupo = m.chat.type !== 'private';

    // No privado, só quem vinculou (igual ao Zap)
    if (!grupo && !b.quemE(ids) && !['vincular', 'ajuda', 'start'].includes(cmd)) {
        return enviarTexto(m.chat.id, 'No privado, primeiro vincule seu Discord: use /zap no Discord e mande aqui */vincular CÓDIGO*.');
    }
    try { b.registrarUso(ids, cmd); } catch { /* contagem do Wrapped; não atrapalha */ }

    if (cmd === 'avisos') {
        if (!grupo) return enviarTexto(m.chat.id, 'Use /avisos dentro do grupo.');
        const membro = await api('getChatMember', { chat_id: m.chat.id, user_id: m.from.id }).catch(() => null);
        if (!['creator', 'administrator'].includes(membro?.status)) return enviarTexto(m.chat.id, 'Só admin do grupo pode usar /avisos.');
        b.setEstado('tg_grupo', String(m.chat.id));
        return enviarTexto(m.chat.id, '📣 Pronto: os avisos de gol e fim de jogo dos times da galera vão sair aqui.');
    }
    if (COMANDOS_SEM_TELEGRAM.includes(cmd)) {
        return enviarTexto(m.chat.id, 'Esse comando por enquanto só funciona no WhatsApp (ou no Discord).', { reply_to_message_id: m.message_id });
    }
    if (['sorteio', 'roleta', 'sortear'].includes(cmd)) return tratarRoleta(sockTelegram, msg, texto);
    if (['enquete', 'enquete+', 'votacao', 'votação'].includes(cmd)) {
        const { pergunta, opcoes, multipla } = lerEnquete(texto);
        if (!pergunta || opcoes.length < 2 || opcoes.length > 10) {
            return enviarTexto(m.chat.id, '🗳️ Use: */enquete Pergunta? | Opção 1 | Opção 2* (de 2 a 10 opções). */enquete+* deixa votar em mais de uma.');
        }
        return api('sendPoll', { chat_id: m.chat.id, question: pergunta.slice(0, 300), options: opcoes.map(o => ({ text: o.slice(0, 100) })), is_anonymous: false, allows_multiple_answers: multipla });
    }
    if (['wrapped', 'retrospectiva'].includes(cmd)) return tratarWrapped(sockTelegram, msg, ids, texto);

    const resposta = await tratar(texto, { ids, nome }, jid);
    if (resposta) await enviarTexto(m.chat.id, resposta, { reply_to_message_id: m.message_id, allow_sending_without_reply: true });
}

// ---------- Avisos de gol / fim de jogo (os mesmos do Zap, marcando a galera no Telegram) ----------
async function postarEventos() {
    const grupo = b.getEstado('tg_grupo');
    const banco = b.banco('bolao');
    if (!grupo || !banco) return;
    let ultimo = Number(b.getEstado('tg_ultimo_evento') ?? 0);
    if (!ultimo) {   // primeira vez: começa do agora, sem despejar aviso velho
        b.setEstado('tg_ultimo_evento', String(banco.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM eventos').get().m || 1));
        return;
    }
    const novos = banco.prepare("SELECT * FROM eventos WHERE id > ? AND criado > datetime('now', '-20 minutes') ORDER BY id").all(ultimo);
    for (const ev of novos) {
        const mencoes = b.torcedoresDe(ev.times).flatMap(t => b.zapIdsDe(t.discord_id).filter(i => i.startsWith('tg:'))
            .map(i => `[${(b.quemE([i])?.nome ?? 'torcedor').replace(/[[\]]/g, '')}](tg://user?id=${i.slice(3)})`));
        const texto = ev.texto + (mencoes.length ? `\n${mencoes.join(' ')}` : '');
        let gif = null;
        try { gif = await gifDoGol(ev.texto); } catch (e) { console.error('Telegram, animação do gol:', e.message); }
        try {
            if (gif) {
                const f = new FormData();
                f.append('chat_id', grupo);
                f.append('animation', new Blob([gif], { type: 'video/mp4' }), 'gol.mp4');
                f.append('caption', texto);
                f.append('parse_mode', 'Markdown');
                await api('sendAnimation', f);
            } else {
                await enviarTexto(grupo, texto);
            }
        } catch (e) {
            console.error('Telegram, aviso de jogo:', e.message);
            return;   // tenta de novo na próxima volta
        }
        b.setEstado('tg_ultimo_evento', String(ev.id));
        ultimo = ev.id;
    }
    if (!novos.length) {   // avança o ponteiro por cima dos avisos velhos descartados
        const max = banco.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM eventos WHERE criado <= datetime('now', '-20 minutes')").get().m;
        if (max > ultimo) b.setEstado('tg_ultimo_evento', String(max));
    }
}

// ---------- Laço principal (long polling) ----------
export async function iniciarTelegram() {
    token = lerToken();
    if (!token) {
        console.log('Telegram desligado: sem TELEGRAM_TOKEN em', ARQUIVO_TOKEN);
        return;
    }
    try {
        eu = await api('getMe');
    } catch (e) {
        console.error('Telegram: token recusado:', e.message);
        return;
    }
    console.log(`✅ Telegram conectado como @${eu.username}`);
    api('setMyCommands', {
        commands: [
            ['ajuda', 'Tudo que o bot faz'], ['vincular', 'Liga seu Telegram ao Discord'], ['filme', 'Procura filme ou série'],
            ['game', 'Procura jogo'], ['nota', 'Dá nota pro último buscado'], ['bolao', 'Próximos jogos do bolão'],
            ['palpite', 'Palpita no bolão'], ['ranking', 'Ranking do bolão'], ['tabela', 'Tabela do Brasileirão'],
            ['meutime', 'Escolhe seu time'], ['torcidas', 'Quem torce pra quem'], ['sorteio', 'Roleta de eliminação'],
            ['enquete', 'Cria enquete'], ['lembrar', 'Marca um lembrete'], ['wrapped', 'Retrospectiva do ano'], ['perfil', 'Seu resumo']
        ].map(([command, description]) => ({ command, description }))
    }).catch(() => {});

    setInterval(() => postarEventos().catch(e => console.error('Telegram, avisos:', e.message)), 10_000);

    let offset = Number(b.getEstado('tg_offset') ?? 0);
    for (;;) {
        try {
            const atualizacoes = await api('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
            for (const u of atualizacoes) {
                offset = u.update_id + 1;
                b.setEstado('tg_offset', String(offset));
                if (u.message?.from && !u.message.from.is_bot) {
                    tratarMensagem(u.message).catch(e => {
                        console.error('Telegram, comando:', e.message);
                        enviarTexto(u.message.chat.id, '⚠️ Deu erro aqui. Tenta de novo daqui a pouco.').catch(() => {});
                    });
                }
            }
        } catch (e) {
            // 409: outro processo está lendo o mesmo bot (reinício da Hostinger) — espera um pouco
            console.error('Telegram:', e.message);
            await new Promise(r => setTimeout(r, e.codigo === 409 ? 30_000 : 5_000));
        }
    }
}
