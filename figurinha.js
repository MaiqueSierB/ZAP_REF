// Figurinhas:
//   !f / !figurinha  → foto, GIF ou vídeo vira figurinha (com texto opcional: "!f bom dia grupo")
//   !print           → responde a uma mensagem de texto e ela vira figurinha "citação" com o nome de quem falou
// Foto sem texto usa sharp; o resto usa ffmpeg (com 1 thread só, limite da hospedagem compartilhada).
// sharp e ffmpeg-static são dependências opcionais: se não instalarem, o resto do bot segue funcionando.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { downloadMediaMessage } from 'baileys';

const exec = promisify(execFile);
export const COMANDOS_FIGURINHA = ['figurinha', 'fig', 'f', 'sticker', 's'];
export const COMANDOS_PRINT = ['print', 'citar', 'quote'];
const FONTE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fontes', 'DejaVuSans-Bold.ttf');
const LIMITE_BYTES = 1_000_000;     // o WhatsApp recusa figurinha animada muito pesada
const ultimoUso = new Map();        // anti-flood: 1 figurinha a cada 5s por pessoa
const nomes = new Map();            // id do WhatsApp -> último nome visto (para o !print)

export function lembrarNome(id, nome) {
    if (id && nome) nomes.set(id, nome);
}

export function desembrulhar(m) {
    for (const k of ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'documentWithCaptionMessage']) {
        if (m?.[k]?.message) m = m[k].message;
    }
    return m;
}

const textoDe = m => m?.conversation || m?.extendedTextMessage?.text || m?.imageMessage?.caption || m?.videoMessage?.caption || '';
const temMidia = m => m?.imageMessage || m?.videoMessage || m?.stickerMessage;

// Mensagem respondida (citada), se houver
export function citada(msg) {
    const m = desembrulhar(msg.message);
    const ctx = m?.extendedTextMessage?.contextInfo || m?.imageMessage?.contextInfo || m?.videoMessage?.contextInfo;
    if (!ctx?.quotedMessage) return null;
    return {
        key: { remoteJid: msg.key.remoteJid, id: ctx.stanzaId, participant: ctx.participant },
        message: desembrulhar(ctx.quotedMessage),
        autor: ctx.participant
    };
}

async function caminhoFfmpeg() {
    try {
        const { default: p } = await import('ffmpeg-static');
        if (p) return p;
    } catch { /* sem o pacote: usa o ffmpeg do sistema, se houver */ }
    return process.env.FFMPEG_PATH || 'ffmpeg';
}

// Quebra o texto em linhas de até `largura` caracteres (sem cortar palavras quando dá)
function quebrar(texto, largura, maxLinhas) {
    const linhas = [];
    let atual = '';
    for (const palavra of texto.split(/\s+/).filter(Boolean)) {
        for (let p = palavra; p.length; p = p.slice(largura)) {
            const pedaco = p.slice(0, largura);
            if (!atual) atual = pedaco;
            else if ((atual + ' ' + pedaco).length <= largura) atual += ' ' + pedaco;
            else { linhas.push(atual); atual = pedaco; }
        }
    }
    if (atual) linhas.push(atual);
    if (linhas.length > maxLinhas) {
        linhas.length = maxLinhas;
        linhas[maxLinhas - 1] = linhas[maxLinhas - 1].slice(0, largura - 1) + '…';
    }
    return linhas;
}

// Roda o ffmpeg num diretório temporário; `montar` recebe a função de execução e o gerador de caminhos.
export async function comFfmpeg(montar, arquivos = {}) {
    const ffmpeg = await caminhoFfmpeg();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fig-'));
    const p = nome => path.join(dir, nome);
    try {
        for (const [nome, conteudo] of Object.entries(arquivos)) await fs.writeFile(p(nome), conteudo);
        return await montar(async args => {
            await exec(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-threads', '1', ...args], { timeout: 60_000 });
        }, p);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

const ENQUADRAR = 'scale=512:512:force_original_aspect_ratio=decrease,format=yuva420p,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black@0';

// Legenda estilo meme (branca com contorno preto) na parte de baixo
function filtroLegenda(arquivoTexto, linhas) {
    const tamanho = linhas > 2 ? 40 : 52;
    return `drawtext=fontfile='${FONTE}':textfile='${arquivoTexto}':fontcolor=white:fontsize=${tamanho}:` +
        'borderw=4:bordercolor=black:line_spacing=6:text_align=C:x=(w-text_w)/2:y=h-text_h-24';
}

async function midiaParaWebp(buffer, { video, legenda }) {
    if (!video && !legenda) {
        const { default: sharp } = await import('sharp');
        sharp.concurrency(1);
        return sharp(buffer).resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).webp({ quality: 80 }).toBuffer();
    }
    const linhas = legenda ? quebrar(legenda.toUpperCase(), 16, 4) : [];
    return comFfmpeg(async (ff, p) => {
        const filtros = [ENQUADRAR, ...(linhas.length ? [filtroLegenda(p('legenda.txt'), linhas.length)] : [])];
        if (!video) {
            await ff(['-i', p('in'), '-filter_threads', '1', '-vf', filtros.join(','), '-frames:v', '1',
                '-c:v', 'libwebp', '-q:v', '80', p('out.webp')]);
            return fs.readFile(p('out.webp'));
        }
        // Vídeo: tenta com qualidade boa e vai reduzindo até caber no limite
        for (const [fps, q] of [[15, 60], [12, 40], [10, 25]]) {
            await ff(['-i', p('in'), '-t', '6', '-an', '-filter_threads', '1', '-vf', [`fps=${fps}`, ...filtros].join(','),
                '-c:v', 'libwebp', '-lossless', '0', '-q:v', String(q), '-loop', '0', '-preset', 'picture', p('out.webp')]);
            const out = await fs.readFile(p('out.webp'));
            if (out.length <= LIMITE_BYTES) return out;
        }
        throw new Error('pesado demais mesmo comprimido');
    }, { in: buffer, 'legenda.txt': linhas.join('\n') });
}

// Figurinha "citação": balão escuro com o nome (verde) e a mensagem
async function printParaWebp(nome, texto) {
    const linhas = quebrar(texto, 22, 10);
    const altura = Math.min(496, 70 + linhas.length * 44 + 20);
    const topo = Math.round((512 - altura) / 2);
    return comFfmpeg(async (ff, p) => {
        // O próprio fundo é o balão (480 x altura), depois centralizado num quadro 512x512 transparente
        await ff(['-f', 'lavfi', '-i', `color=c=0x1f2c34:s=480x${altura}`, '-frames:v', '1', '-filter_threads', '1', '-vf', [
            'format=yuva420p',
            `pad=512:512:16:${topo}:color=black@0`,
            `drawtext=fontfile='${FONTE}':textfile='${p('nome.txt')}':fontcolor=0x25D366:fontsize=28:x=40:y=${topo + 22}`,
            `drawtext=fontfile='${FONTE}':textfile='${p('texto.txt')}':fontcolor=white:fontsize=30:line_spacing=8:x=40:y=${topo + 70}`
        ].join(','), '-c:v', 'libwebp', '-q:v', '85', p('out.webp')]);
        return fs.readFile(p('out.webp'));
    }, { 'nome.txt': nome.slice(0, 28), 'texto.txt': linhas.join('\n') });
}

function liberado(chave) {
    if (Date.now() - (ultimoUso.get(chave) ?? 0) < 5_000) return false;
    ultimoUso.set(chave, Date.now());
    return true;
}

async function falhou(responder, e) {
    console.error('Figurinha:', e.message);   // detalhe completo só no log, não no grupo
    await responder(/Cannot find (package|module)|ENOENT/.test(e.message)
        ? '⚠️ A conversão de figurinha não está disponível no servidor agora.'
        : /pesado demais/.test(e.message)
            ? '⚠️ Esse vídeo ficou pesado demais pra figurinha. Tenta um mais curto ou menor.'
            : '⚠️ Não consegui fazer essa figurinha. Tenta outra mídia.');
}

// !f [texto]: mídia da própria mensagem ou da mensagem respondida
export async function tratarFigurinha(sock, msg, chave, texto) {
    const responder = text => sock.sendMessage(msg.key.remoteJid, { text }, { quoted: msg });
    const propria = desembrulhar(msg.message);
    const alvo = temMidia(propria) ? { ...msg, message: propria } : citada(msg);
    const legenda = texto.trim().replace(/^\S+\s*/, '').trim().slice(0, 80);

    if (!alvo || !temMidia(alvo.message)) {
        return responder('📎 Manda uma *foto, GIF ou vídeo* com a legenda *!f* (ou *!f seu texto* pra figurinha com legenda) — ou responda a uma foto/vídeo com *!f*.\n' +
            'Pra transformar uma *mensagem* em figurinha, responda ela com *!print*.');
    }
    if (!liberado(chave)) return;
    const m = alvo.message;
    if (m.stickerMessage) return responder('Isso já é uma figurinha 😅');
    if (m.videoMessage && (m.videoMessage.seconds ?? 0) > 15) {
        return responder('🎬 Vídeo muito longo. Manda um de até 15 segundos (a figurinha usa os 6 primeiros).');
    }
    try {
        const buffer = await downloadMediaMessage(alvo, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
        const webp = await midiaParaWebp(buffer, { video: Boolean(m.videoMessage), legenda });
        await sock.sendMessage(msg.key.remoteJid, { sticker: webp }, { quoted: msg });
    } catch (e) {
        await falhou(responder, e);
    }
}

// !print: responde a uma mensagem de texto
export async function tratarPrint(sock, msg, chave) {
    const responder = text => sock.sendMessage(msg.key.remoteJid, { text }, { quoted: msg });
    const c = citada(msg);
    const texto = textoDe(c?.message).trim();
    if (!c || !texto) return responder('💬 Responda a uma *mensagem de texto* com *!print* pra virar figurinha.');
    if (!liberado(chave)) return;
    const nome = nomes.get(c.autor) || (c.autor ? `+${c.autor.split('@')[0].split(':')[0]}` : 'alguém');
    try {
        await sock.sendMessage(msg.key.remoteJid, { sticker: await printParaWebp(nome, texto) }, { quoted: msg });
    } catch (e) {
        await falhou(responder, e);
    }
}
