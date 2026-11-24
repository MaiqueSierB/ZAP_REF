import http from 'node:http';
import fs from 'node:fs';
import pino from 'pino';
import makeWASocket, {
    Browsers, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState
} from 'baileys';
import config from './config.js';
import { tratar } from './comandos.js';
import { quemE, registrarUso } from './bancos.js';
import { verificarAniversarios } from './aniversarios.js';
import { pegarTrava } from './trava.js';
import { postarEventos } from './aovivo.js';
import { verificarRetro } from './retro.js';
import { verificarEpic } from './epic.js';
import { tratarGym, COMANDOS_GYM } from './gym.js';
import { tratarFigurinha, tratarPrint, lembrarNome, COMANDOS_FIGURINHA, COMANDOS_PRINT } from './figurinha.js';
import { tratarEnquete, COMANDOS_ENQUETE } from './enquete.js';
import { enviarLembretes } from './lembretes.js';
import { tratarRoleta, COMANDOS_ROLETA } from './roleta.js';
import path from 'node:path';
import { rotaWrapped, tratarWrapped, verificarWrapped, COMANDOS_WRAPPED } from './wrapped.js';

const logger = pino({ level: 'silent' });
let estado = 'iniciando';
let sock = null;
let tentativas = 0;

// ---------- Jeito de gente (menos cara de robô para o WhatsApp) ----------
const espera = ms => new Promise(r => setTimeout(r, ms));

// "digitando..." por 1 a 3 segundos antes de responder
async function digitando(chatId) {
    try { await sock.sendPresenceUpdate('composing', chatId); } catch { /* só estética */ }
    await espera(1_000 + Math.floor(Math.random() * 2_000));
}

// Ignora o mesmo comando repetido em 15 s e mais de 6 comandos por minuto da mesma pessoa
const ultimosComandos = new Map();   // pessoa -> [{ texto, quando }]
function floodou(pessoa, texto) {
    const agora = Date.now();
    const t = texto.trim().toLowerCase();
    const recentes = (ultimosComandos.get(pessoa) ?? []).filter(c => agora - c.quando < 60_000);
    const repetido = recentes.some(c => c.texto === t && agora - c.quando < 15_000);
    const cabe = !repetido && recentes.length < 6;
    if (cabe) recentes.push({ texto: t, quando: agora });
    ultimosComandos.set(pessoa, recentes);
    if (ultimosComandos.size > 500) {   // limpa quem sumiu
        for (const [k, v] of ultimosComandos) if (!v.some(c => agora - c.quando < 60_000)) ultimosComandos.delete(k);
    }
    return !cabe;
}

// Texto da mensagem, inclusive quando vem embrulhada (mensagens temporárias, etc.)
function textoDa(msg) {
    let m = msg.message;
    for (const k of ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'documentWithCaptionMessage']) {
        if (m?.[k]?.message) m = m[k].message;
    }
    return m?.conversation || m?.extendedTextMessage?.text || m?.imageMessage?.caption || m?.videoMessage?.caption || '';
}

let codigosNaoUsados = 0;

async function conectar() {
    fs.mkdirSync(config.authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

    sock = makeWASocket({
        auth: state,
        logger,
        version,
        browser: Browsers.ubuntu('Chrome'),
        markOnlineOnConnect: false,
        syncFullHistory: false
    });
    sock.ev.on('creds.update', saveCreds);

    let pareamentoPedido = false;
    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        // Primeiro acesso: em vez de QR Code, gera um código de pareamento para digitar no celular.
        if (!sock.authState.creds.registered && !pareamentoPedido && qr) {
            if (!config.numero) {
                console.error('ZAP_NUMERO não configurado: não dá para parear.');
                return;
            }
            pareamentoPedido = true;
            try {
                const codigo = await sock.requestPairingCode(config.numero);
                estado = 'aguardando pareamento';
                console.log(`CÓDIGO DE PAREAMENTO: ${codigo?.match(/.{1,4}/g)?.join('-') ?? codigo} ` +
                    '(WhatsApp > Aparelhos conectados > Conectar aparelho > Conectar com número de telefone)');
            } catch (e) {
                console.error('Falha ao pedir código de pareamento:', e.message);
            }
        }

        if (connection === 'open') {
            codigosNaoUsados = 0;
            estado = 'conectado';
            tentativas = 0;
            console.log(`✅ WhatsApp conectado como ${sock.user?.id}`);
            // Aniversários, retrospectiva semanal e jogos grátis: agora e de 30 em 30 minutos (um único timer por processo).
            const checar = () => {
                verificarAniversarios(sock).catch(e => console.error('Aniversários:', e.message));
                verificarRetro(sock).catch(e => console.error('Retrospectiva:', e.message));
                verificarEpic(sock).catch(e => console.error('Jogos grátis:', e.message));
                verificarWrapped(sock).catch(e => console.error('Wrapped:', e.message));
            };
            setTimeout(checar, 10_000);
            if (!globalThis.timerAniversarios) globalThis.timerAniversarios = setInterval(checar, 30 * 60_000);
            // Avisos de gol/fim de jogo (gerados pelo bot do bolão) a cada 10s
            if (!globalThis.timerLembretes) globalThis.timerLembretes = setInterval(
                () => enviarLembretes(sock).catch(e => console.error('Lembretes:', e.message)), 20_000);
            if (!globalThis.timerAoVivo) globalThis.timerAoVivo = setInterval(
                () => postarEventos(sock).catch(e => console.error('Avisos de jogo:', e.message)), 10_000);
        }

        if (connection === 'close') {
            const codigo = lastDisconnect?.error?.output?.statusCode;
            estado = `desconectado (${codigo ?? '?'})`;
            // Ainda sem parear: não fica pedindo código novo a cada minuto (o WhatsApp vê isso como robô)
            if (!sock.authState.creds.registered) {
                fs.rmSync(config.authDir, { recursive: true, force: true });
                codigosNaoUsados++;
                // Depois de 3 códigos sem uso, para de pedir: só volta quando o app for reiniciado (hPanel → Reiniciar)
                if (codigosNaoUsados >= 3) {
                    estado = 'pausado: aguardando pareamento (reinicie o app para gerar código)';
                    console.warn('3 códigos de pareamento sem uso. Parei de pedir; reinicie o app quando for parear.');
                    return;
                }
                console.warn('Código de pareamento não foi usado. Gero outro em 10 minutos.');
                setTimeout(() => conectar().catch(e => console.error('Falha ao reconectar:', e.message)), 10 * 60_000);
                return;
            }
            codigosNaoUsados = 0;
            if (codigo === DisconnectReason.loggedOut) {
                if (sock.authState.creds.registered) {
                    console.error('Sessão encerrada pelo WhatsApp (logout). Limpando a sessão para parear de novo.');
                }
                // Sessão inválida ou pareamento não concluído: apaga e recomeça (gera código novo).
                fs.rmSync(config.authDir, { recursive: true, force: true });
                setTimeout(() => conectar().catch(e => console.error('Falha ao reconectar:', e.message)), 5_000);
                return;
            }
            // Outra instância assumiu a sessão: espera mais antes de tentar, para não ficar disputando.
            const aguardar = codigo === DisconnectReason.connectionReplaced ? 60_000 : Math.min(30_000, 2_000 * 2 ** tentativas++);
            console.warn(`Conexão caiu (código ${codigo}). Reconectando em ${Math.round(aguardar / 1000)}s...`);
            setTimeout(() => conectar().catch(e => console.error('Falha ao reconectar:', e.message)), aguardar);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            try {
                if (msg.key.fromMe) continue;
                const chatId = msg.key.remoteJid || '';
                if (chatId === 'status@broadcast' || chatId.endsWith('@newsletter') || chatId.endsWith('@broadcast')) continue;
                const grupo = chatId.endsWith('@g.us');
                const texto = textoDa(msg);
                // Guarda o nome de quem fala (o !print usa para assinar a figurinha)
                for (const id of [msg.key.participant, msg.key.participantAlt, grupo ? null : chatId]) lembrarNome(id, msg.pushName);
                if (!texto.startsWith(config.prefixo)) continue;
                const cmd = texto.trim().slice(config.prefixo.length).split(/\s+/)[0].toLowerCase();
                if (grupo && config.grupoId && chatId !== config.grupoId && cmd !== 'id') continue;

                // O remetente pode vir como número (@s.whatsapp.net) ou id oculto (@lid).
                const ids = [...new Set((grupo
                    ? [msg.key.participantAlt, msg.key.participant]
                    : [msg.key.remoteJidAlt, msg.key.senderPn, chatId]).filter(Boolean))];

                // No privado, só atende quem já vinculou a conta (menos risco de ban); desconhecidos só podem !vincular.
                if (!grupo && !quemE(ids) && cmd !== 'vincular') continue;

                if (floodou(ids[0] ?? chatId, texto)) continue;
                await digitando(chatId);

                // Contagem de uso (alimenta o Wrapped); nunca atrapalha o comando
                try { registrarUso(ids, cmd); } catch (e) { console.error('Uso:', e.message); }

                if (COMANDOS_WRAPPED.includes(cmd)) {
                    await tratarWrapped(sock, msg, ids, texto);
                    continue;
                }

                // Figurinha precisa da mensagem inteira (foto/vídeo), não só do texto
                if (COMANDOS_GYM.includes(cmd)) {
                    await tratarGym(sock, msg, ids, texto);
                    continue;
                }
                if (COMANDOS_FIGURINHA.includes(cmd)) {
                    await tratarFigurinha(sock, msg, ids[0], texto);
                    continue;
                }
                if (COMANDOS_PRINT.includes(cmd)) {
                    await tratarPrint(sock, msg, ids[0]);
                    continue;
                }
                if (COMANDOS_ENQUETE.includes(cmd)) {
                    await tratarEnquete(sock, msg, texto);
                    continue;
                }
                // Roleta roda em segundo plano (edita a mesma mensagem por vários segundos)
                if (COMANDOS_ROLETA.includes(cmd)) {
                    tratarRoleta(sock, msg, texto).catch(e => console.error('Roleta:', e.message));
                    continue;
                }
                const resposta = await tratar(texto, { ids, nome: msg.pushName }, chatId);
                if (resposta) await sock.sendMessage(chatId, { text: resposta }, { quoted: msg });
            } catch (e) {
                console.error('Erro ao tratar mensagem:', e.message);
                await sock.sendMessage(msg.key.remoteJid, { text: '⚠️ Deu erro aqui. Tenta de novo daqui a pouco.' }, { quoted: msg })
                    .catch(() => {});
            }
        }
    });
}

// Servidor HTTP: páginas do Wrapped e, no resto, o health check (a hospedagem precisa de uma porta respondendo).
http.createServer(async (req, res) => {
    try {
        if (await rotaWrapped(req, res)) return;
    } catch (e) {
        console.error('Página do Wrapped:', e.message);
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Deu erro ao montar o Wrapped. Tenta de novo daqui a pouco.');
    }
    // Pausa proposital conta como "no ar" para o monitor não alarmar
    const ok = estado === 'conectado' || estado.startsWith('pausado');
    res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok, estado }));
}).listen(Number(process.env.PORT || 3000), () => console.log(`Health check na porta ${process.env.PORT || 3000}`));

// Só conecta depois da pausa (se houver) e de garantir que nenhum outro processo está usando a sessão.
async function iniciar() {
    const falta = config.pausaAte - Date.now();
    if (falta > 0) {
        estado = `pausado até ${config.pausaAte.toLocaleString('pt-BR')}`;
        console.log(`WhatsApp em pausa: conecto em ${Math.round(falta / 60_000)} min.`);
        await new Promise(r => setTimeout(r, falta));
    }
    await pegarTrava(path.join(path.dirname(config.authDir), 'zap.lock'));
    await conectar();
}

iniciar().catch(e => {
    estado = 'erro';
    console.error('Falha ao iniciar o WhatsApp:', e);
});
