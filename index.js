import http from 'node:http';
import fs from 'node:fs';
import pino from 'pino';
import makeWASocket, {
    Browsers, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState
} from 'baileys';
import config from './config.js';
import { tratar } from './comandos.js';
import { quemE } from './bancos.js';
import { verificarAniversarios } from './aniversarios.js';
import { pegarTrava } from './trava.js';
import { postarEventos } from './aovivo.js';
import path from 'node:path';

const logger = pino({ level: 'silent' });
let estado = 'iniciando';
let sock = null;
let tentativas = 0;

// Texto da mensagem, inclusive quando vem embrulhada (mensagens temporárias, etc.)
function textoDa(msg) {
    let m = msg.message;
    for (const k of ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'documentWithCaptionMessage']) {
        if (m?.[k]?.message) m = m[k].message;
    }
    return m?.conversation || m?.extendedTextMessage?.text || m?.imageMessage?.caption || m?.videoMessage?.caption || '';
}

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
            estado = 'conectado';
            tentativas = 0;
            console.log(`✅ WhatsApp conectado como ${sock.user?.id}`);
            // Confere aniversários agora e de 30 em 30 minutos (um único timer por processo).
            const checar = () => verificarAniversarios(sock).catch(e => console.error('Aniversários:', e.message));
            setTimeout(checar, 10_000);
            if (!globalThis.timerAniversarios) globalThis.timerAniversarios = setInterval(checar, 30 * 60_000);
            // Avisos de gol/fim de jogo (gerados pelo bot do bolão) a cada 10s
            if (!globalThis.timerAoVivo) globalThis.timerAoVivo = setInterval(
                () => postarEventos(sock).catch(e => console.error('Avisos de jogo:', e.message)), 10_000);
        }

        if (connection === 'close') {
            const codigo = lastDisconnect?.error?.output?.statusCode;
            estado = `desconectado (${codigo ?? '?'})`;
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
            const espera = codigo === DisconnectReason.connectionReplaced ? 60_000 : Math.min(30_000, 2_000 * 2 ** tentativas++);
            console.warn(`Conexão caiu (código ${codigo}). Reconectando em ${Math.round(espera / 1000)}s...`);
            setTimeout(() => conectar().catch(e => console.error('Falha ao reconectar:', e.message)), espera);
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
                if (!texto.startsWith(config.prefixo)) continue;
                const cmd = texto.trim().slice(config.prefixo.length).split(/\s+/)[0].toLowerCase();
                if (grupo && config.grupoId && chatId !== config.grupoId && cmd !== 'id') continue;

                // O remetente pode vir como número (@s.whatsapp.net) ou id oculto (@lid).
                const ids = [...new Set((grupo
                    ? [msg.key.participantAlt, msg.key.participant]
                    : [msg.key.remoteJidAlt, msg.key.senderPn, chatId]).filter(Boolean))];

                // No privado, só atende quem já vinculou a conta (menos risco de ban); desconhecidos só podem !vincular.
                if (!grupo && !quemE(ids) && cmd !== 'vincular') continue;
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

// Servidor HTTP mínimo: a hospedagem precisa de uma porta respondendo.
http.createServer((req, res) => {
    const ok = estado === 'conectado';
    res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok, estado }));
}).listen(Number(process.env.PORT || 3000), () => console.log(`Health check na porta ${process.env.PORT || 3000}`));

// Só conecta depois de garantir que nenhum outro processo está usando a sessão.
pegarTrava(path.join(path.dirname(config.authDir), 'zap.lock')).then(() => conectar()).catch(e => {
    estado = 'erro';
    console.error('Falha ao iniciar o WhatsApp:', e);
});
