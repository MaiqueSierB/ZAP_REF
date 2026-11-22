// Animação de gol (vira "GIF" no WhatsApp): placar estilo TV, gerado pelo bot — sem imagem de ninguém.
// 480x480, ~3 s em loop: "GOOOL!" crescendo, piscando nas cores do time e depois o placar com o minuto e o autor.
import { comFfmpeg } from './figurinha.js';
import { identificarTime } from './times.js';

// Cores principais [fundo, destaque] dos clubes; quem não está aqui fica verde e amarelo
const CORES = {
    'atletico-mg': ['#111111', '#ffffff'], 'athletico-pr': ['#c8102e', '#111111'], 'atletico-go': ['#c8102e', '#111111'],
    'america-mg': ['#0a7a3d', '#111111'], 'sao-paulo': ['#d71920', '#111111'], flamengo: ['#c8102e', '#111111'],
    fluminense: ['#7a1131', '#0b6b3a'], palmeiras: ['#006437', '#ffffff'], corinthians: ['#111111', '#ffffff'],
    santos: ['#111111', '#ffffff'], vasco: ['#111111', '#ffffff'], gremio: ['#0d80bf', '#111111'],
    internacional: ['#c8102e', '#ffffff'], cruzeiro: ['#1b3a8c', '#ffffff'], bahia: ['#0055a4', '#d71920'],
    vitoria: ['#d71920', '#111111'], fortaleza: ['#0055a4', '#d71920'], ceara: ['#111111', '#ffffff'],
    bragantino: ['#d71920', '#ffffff'], sport: ['#c8102e', '#111111'], juventude: ['#0a7a3d', '#ffffff'],
    mirassol: ['#f2c500', '#0a7a3d'], goias: ['#0a7a3d', '#ffffff'], 'vila-nova': ['#c8102e', '#ffffff'],
    coritiba: ['#0a7a3d', '#ffffff'], cuiaba: ['#0a7a3d', '#f2c500'], chapecoense: ['#0a7a3d', '#ffffff'],
    criciuma: ['#f2c500', '#111111'], remo: ['#13294b', '#ffffff'], paysandu: ['#4aa3df', '#ffffff'],
    novorizontino: ['#f2c500', '#111111'], avai: ['#0055a4', '#ffffff'], 'ponte-preta': ['#111111', '#ffffff'],
    guarani: ['#0a7a3d', '#ffffff'], nautico: ['#c8102e', '#ffffff'], 'santa-cruz': ['#c8102e', '#111111'],
    botafogo: ['#111111', '#ffffff'], 'botafogo-sp': ['#c8102e', '#111111'], 'botafogo-pb': ['#111111', '#ffffff'],
    crb: ['#c8102e', '#ffffff'], csa: ['#0055a4', '#ffffff'], figueirense: ['#111111', '#ffffff'],
    londrina: ['#4aa3df', '#ffffff'], abc: ['#111111', '#ffffff'], amazonas: ['#f2c500', '#111111']
};
const PADRAO = ['#009c3b', '#ffdf00'];

// "⚽ *GOL DO FLAMENGO!* (34' — Pedro)\nFlamengo 1 x 0 Palmeiras" → partes do aviso
export function lerGol(texto) {
    const m = String(texto).match(/GOL DO (.+?)!\*(?: \(([^)]*)\))?\s*\n(.+)/s);
    if (!m) return null;
    return { time: m[1].trim(), detalhe: (m[2] ?? '').trim(), placar: m[3].trim().split('\n')[0] };
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const corte = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
// Texto escuro em fundo claro e vice-versa
const contraste = hex => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
    return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? '#111111' : '#ffffff';
};

const W = 480;
// Tamanho de letra que cabe na largura (a DejaVu Bold tem ~0,7 da altura por caractere)
const caber = (t, max, margem = 40) => Math.min(max, Math.floor((W - margem) / (Math.max(1, t.length) * 0.7)));
const svg = (fundo, conteudo) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}">
<rect width="${W}" height="${W}" fill="${fundo}"/>${conteudo}</svg>`;
const texto = (y, tam, cor, t, extra = '') =>
    `<text x="${W / 2}" y="${y}" font-family="DejaVu Sans" font-weight="bold" font-size="${tam}" fill="${cor}" text-anchor="middle" ${extra}>${esc(t)}</text>`;
const listras = cor => Array.from({ length: 8 }, (_, i) =>
    `<polygon points="${i * 140 - 240},${W} ${i * 140 - 170},${W} ${i * 140 + 310},0 ${i * 140 + 240},0" fill="${cor}" opacity="0.18"/>`).join('');

// "Flamengo 1 x 0 Palmeiras" → nomes em cima e embaixo, números grandes no meio (estilo placar de TV)
function blocoPlacar(placar) {
    const m = placar.match(/^(.+?) (\d+) x (\d+) (.+)$/);
    if (!m) return texto(245, caber(placar, 34, 90), '#ffffff', corte(placar, 34));
    const [, casa, gc, gf, fora] = m;
    return texto(180, caber(casa, 30, 100), '#ffffff', corte(casa, 24)) +
        texto(262, 76, '#ffffff', `${gc} x ${gf}`) +
        texto(312, caber(fora, 30, 100), '#ffffff', corte(fora, 24));
}

function quadros({ time, detalhe, placar }, [c1, c2]) {
    const t1 = contraste(c1), t2 = contraste(c2);
    const f = [];
    // 1) "GOOOL!" crescendo
    for (let i = 0; i < 8; i++) {
        const tam = Math.round(30 + (i / 7) * (caber('GOOOL!', 120) - 30));
        f.push(svg(c1, listras(c2) + texto(W / 2 + tam / 3, tam, t1, 'GOOOL!', `transform="rotate(${(7 - i) * -2} ${W / 2} ${W / 2})"`)));
    }
    // 2) pisca nas cores do time
    for (let i = 0; i < 10; i++) {
        const [fundo, cor] = Math.floor(i / 2) % 2 ? [c2, t2] : [c1, t1];
        f.push(svg(fundo, listras(fundo === c1 ? c2 : c1) + texto(W / 2 + 40, caber('GOOOL!', 120), cor, 'GOOOL!') +
            texto(W / 2 + 100, caber(time, 34), cor, corte(time.toUpperCase(), 22))));
    }
    // 3) placar (fica parado mais tempo)
    const final = svg(c1, listras(c2) +
        `<rect x="30" y="135" width="${W - 60}" height="200" rx="22" fill="#000" opacity="0.35"/>` +
        texto(100, caber(`GOL DO ${time}`, 44), t1, `GOL DO ${corte(time.toUpperCase(), 18)}`) +
        blocoPlacar(placar) +
        (detalhe ? texto(380, caber(detalhe, 30), t1, corte(detalhe, 30)) : '') +
        texto(440, 20, t1, 'REGRESSO', 'opacity="0.7"'));
    for (let i = 0; i < 18; i++) f.push(final);
    return f;
}

// Devolve um mp4 curto (o WhatsApp mostra como GIF com gifPlayback: true)
export async function gifDoGol(aviso) {
    const gol = lerGol(aviso);
    if (!gol) return null;
    const cores = CORES[identificarTime(gol.time)?.key] ?? PADRAO;
    const { default: sharp } = await import('sharp');
    sharp.concurrency(1);
    const arquivos = {};
    const lista = quadros(gol, cores);
    for (let i = 0; i < lista.length; i++) {
        arquivos[`q${String(i).padStart(3, '0')}.png`] = await sharp(Buffer.from(lista[i])).png().toBuffer();
    }
    return comFfmpeg(async (ffmpeg, p) => {
        await ffmpeg(['-framerate', '12', '-i', p('q%03d.png'), '-filter_threads', '1', '-vf', 'format=yuv420p',
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-threads', '1', '-x264-params', 'threads=1:lookahead-threads=1',
            '-movflags', '+faststart', '-an', p('gol.mp4')]);
        const fs = await import('node:fs/promises');
        return fs.readFile(p('gol.mp4'));
    }, arquivos);
}
