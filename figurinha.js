// !figurinha: transforma foto, GIF ou vídeo curto em figurinha do WhatsApp.
// Foto → WebP 512x512 (sharp). Vídeo/GIF → WebP animado de até 6s (ffmpeg).
// sharp e ffmpeg-static são dependências opcionais: se não instalarem, o resto do bot segue funcionando.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { downloadMediaMessage } from 'baileys';

const exec = promisify(execFile);
export const COMANDOS_FIGURINHA = ['figurinha', 'fig', 'f', 'sticker', 's'];
const LIMITE_BYTES = 1_000_000;     // o WhatsApp recusa figurinha animada muito pesada
const ultimoUso = new Map();        // anti-flood: 1 figurinha a cada 5s por pessoa

function desembrulhar(m) {
    for (const k of ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'documentWithCaptionMessage']) {
        if (m?.[k]?.message) m = m[k].message;
    }
    return m;
}

// A mídia pode vir na própria mensagem (legenda "!figurinha") ou na mensagem respondida.
function acharMidia(msg) {
    const m = desembrulhar(msg.message);
    if (m?.imageMessage || m?.videoMessage || m?.stickerMessage) return msg;
    const ctx = m?.extendedTextMessage?.contextInfo;
    const citada = desembrulhar(ctx?.quotedMessage);
    if (citada?.imageMessage || citada?.videoMessage || citada?.stickerMessage) {
        return { key: { remoteJid: msg.key.remoteJid, id: ctx.stanzaId, participant: ctx.participant }, message: citada };
    }
    return null;
}

async function imagemParaWebp(buffer) {
    const { default: sharp } = await import('sharp');
    sharp.concurrency(1);   // mesmo motivo do ffmpeg: poucas threads na hospedagem
    return sharp(buffer)
        .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .webp({ quality: 80 })
        .toBuffer();
}

async function videoParaWebp(buffer) {
    const { default: ffmpeg } = await import('ffmpeg-static');
    if (!ffmpeg) throw new Error('ffmpeg indisponível');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fig-'));
    const entrada = path.join(dir, 'in');
    const saida = path.join(dir, 'out.webp');
    try {
        await fs.writeFile(entrada, buffer);
        // Tenta com qualidade boa; se passar do limite, reduz qualidade e fps.
        for (const [fps, q] of [[15, 60], [12, 40], [10, 25]]) {
            // 1 thread só: a hospedagem compartilhada limita processos/threads (senão dá "Resource temporarily unavailable")
            await exec(ffmpeg, ['-y', '-threads', '1', '-i', entrada, '-t', '6', '-an', '-filter_threads', '1',
                '-vf', `fps=${fps},scale=512:512:force_original_aspect_ratio=decrease,format=yuva420p,` +
                    'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black@0',
                '-c:v', 'libwebp', '-threads', '1', '-lossless', '0', '-q:v', String(q), '-loop', '0', '-preset', 'picture',
                saida], { timeout: 60_000 });
            const out = await fs.readFile(saida);
            if (out.length <= LIMITE_BYTES) return out;
        }
        throw new Error('vídeo pesado demais mesmo comprimido');
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

// Devolve true se tratou a mensagem (mesmo que com erro), false se não era pedido de figurinha.
export async function tratarFigurinha(sock, msg, chave) {
    const alvo = acharMidia(msg);
    const responder = text => sock.sendMessage(msg.key.remoteJid, { text }, { quoted: msg });
    if (!alvo) {
        await responder('📎 Manda uma *foto, GIF ou vídeo* com a legenda *!figurinha* — ou responda a uma foto/vídeo com *!figurinha*.');
        return true;
    }
    if (Date.now() - (ultimoUso.get(chave) ?? 0) < 5_000) return true;
    ultimoUso.set(chave, Date.now());

    const m = alvo.message;
    if (m.stickerMessage) {
        await responder('Isso já é uma figurinha 😅');
        return true;
    }
    const segundos = m.videoMessage?.seconds ?? 0;
    if (m.videoMessage && segundos > 15) {
        await responder('🎬 Vídeo muito longo. Manda um de até 15 segundos (a figurinha usa os 6 primeiros).');
        return true;
    }
    try {
        const buffer = await downloadMediaMessage(alvo, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
        const webp = m.videoMessage ? await videoParaWebp(buffer) : await imagemParaWebp(buffer);
        await sock.sendMessage(msg.key.remoteJid, { sticker: webp }, { quoted: msg });
    } catch (e) {
        console.error('Figurinha:', e.message);   // detalhe completo só no log, não no grupo
        await responder(/Cannot find (package|module)|ffmpeg indisponível/.test(e.message)
            ? '⚠️ A conversão de figurinha não está disponível no servidor agora.'
            : /pesado demais/.test(e.message)
                ? '⚠️ Esse vídeo ficou pesado demais pra figurinha. Tenta um mais curto ou menor.'
                : '⚠️ Não consegui fazer essa figurinha. Tenta outra mídia.');
    }
    return true;
}
