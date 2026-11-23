// Regresso Wrapped: a retrospectiva do ano de cada pessoa e do grupo.
// Junta os bancos do RMDB, RGDB, bolão, aniversários e do próprio Zap. Gera:
//  - página web (servida pelo app do Zap em /wrapped e /wrapped/<id do Discord>)
//  - cartão em imagem (PNG) para mandar no grupo
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { banco, quemE, getEstado, setEstado } from './bancos.js';
import config from './config.js';

// Os cartões são desenhados em SVG pelo sharp. A hospedagem não tem fontes instaladas,
// então apontamos o fontconfig para a fonte que vem junto com o bot.
const FONTES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fontes');
const FONTS_CONF = path.join(os.tmpdir(), 'regresso-fonts.conf');
try {
    fs.writeFileSync(FONTS_CONF, `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig>` +
        `<dir>${FONTES}</dir><cachedir>${path.join(os.tmpdir(), 'regresso-fontcache')}</cachedir></fontconfig>`);
    process.env.FONTCONFIG_FILE = FONTS_CONF;
} catch (e) {
    console.warn('Wrapped: não deu para configurar as fontes:', e.message);
}

export const URL_BASE = (process.env.WRAPPED_URL || 'https://zap.mrbnexus.com.br').replace(/\/$/, '');

// Em janeiro ainda vale o Wrapped do ano que acabou
export function anoWrapped(agora = new Date()) {
    return agora.getMonth() === 0 ? agora.getFullYear() - 1 : agora.getFullYear();
}

const all = (nome, sql, ...args) => banco(nome)?.prepare(sql).all(...args) ?? [];
const get = (nome, sql, ...args) => banco(nome)?.prepare(sql).get(...args);

// ---------- Cálculo ----------

// Estatísticas de avaliações (filmes ou jogos) por pessoa e do grupo
function avaliacoes(nome, votos, itens, idCol, comPoster) {
    const poster = comPoster ? 'i.poster_url' : 'NULL';
    const votosDe = all(nome, `
        SELECT v.${idCol} AS id, v.user_id, v.username, v.score, i.title, ${poster} AS poster, i.server_score AS grupo, i.vote_count AS n,
               CASE WHEN i.vote_count > 1 THEN (i.server_score * i.vote_count - v.score) / (i.vote_count - 1) END AS outros
        FROM ${votos} v JOIN ${itens} i ON i.${idCol} = v.${idCol}`);

    const porPessoa = new Map();
    for (const v of votosDe) {
        if (!porPessoa.has(v.user_id)) porPessoa.set(v.user_id, []);
        porPessoa.get(v.user_id).push(v);
    }

    const pessoas = new Map();
    for (const [id, vs] of porPessoa) {
        const media = vs.reduce((s, v) => s + v.score, 0) / vs.length;
        const ordenados = [...vs].sort((a, b) => b.score - a.score || b.grupo - a.grupo);
        // Divergência: só conta itens que pelo menos mais 2 pessoas avaliaram
        const comparaveis = vs.filter(v => v.n >= 3);
        const divergencias = comparaveis.map(v => ({ ...v, dif: v.score - v.outros }));
        const brigou = [...divergencias].sort((a, b) => Math.abs(b.dif) - Math.abs(a.dif))[0];
        pessoas.set(id, {
            nomeUsuario: vs.find(v => v.username)?.username,
            n: vs.length,
            media,
            favorito: ordenados[0],
            pior: ordenados.length > 1 ? ordenados.at(-1) : null,
            brigou: brigou && Math.abs(brigou.dif) >= 1.5 ? brigou : null,
            divergencia: comparaveis.length >= 5
                ? divergencias.reduce((s, v) => s + Math.abs(v.dif), 0) / divergencias.length : null
        });
    }

    const lista = all(nome, `SELECT ${idCol} AS id, title, ${poster} AS poster, server_score AS nota, vote_count AS n FROM ${itens} i`);
    const minimo = lista.some(i => i.n >= 3) ? 3 : 2;
    const relevantes = lista.filter(i => i.n >= minimo);
    // Polêmica = variância das notas do item
    const variancia = new Map(all(nome, `
        SELECT ${idCol} AS id, AVG(score * score) - AVG(score) * AVG(score) AS var FROM ${votos}
        GROUP BY ${idCol} HAVING COUNT(*) >= ?`, minimo).map(r => [r.id, r.var]));

    return {
        pessoas,
        totalItens: lista.length,
        totalVotos: votosDe.length,
        media: votosDe.length ? votosDe.reduce((s, v) => s + v.score, 0) / votosDe.length : null,
        top: [...relevantes].sort((a, b) => b.nota - a.nota || b.n - a.n).slice(0, 5),
        piores: [...relevantes].sort((a, b) => a.nota - b.nota || b.n - a.n).slice(0, 3),
        maisVotado: [...lista].sort((a, b) => b.n - a.n || b.nota - a.nota)[0] ?? null,
        polemico: [...relevantes].filter(i => variancia.has(i.id))
            .sort((a, b) => variancia.get(b.id) - variancia.get(a.id))
            .map(i => ({ ...i, desvio: Math.sqrt(Math.max(0, variancia.get(i.id))) }))[0] ?? null
    };
}

function bolao(ano) {
    const temporada = get('bolao', 'SELECT MAX(temporada) AS t FROM jogos WHERE temporada <= ?', ano)?.t;
    if (temporada == null) return { temporada: null, ranking: [] };
    const ranking = all('bolao', `
        SELECT p.user_id, MAX(p.username) AS nome, COUNT(*) AS palpites,
               COALESCE(SUM(p.pontos), 0) AS pontos,
               SUM(CASE WHEN p.pontos = 25 THEN 1 ELSE 0 END) AS exatos,
               SUM(CASE WHEN p.pontos = 0 THEN 1 ELSE 0 END) AS zerados
        FROM palpites p JOIN jogos j ON j.id = p.jogo_id
        WHERE j.temporada = ? GROUP BY p.user_id
        ORDER BY pontos DESC, exatos DESC`, temporada);
    ranking.forEach((r, i) => { r.posicao = i + 1; });
    return { temporada, ranking };
}

// Uso dos comandos no Zap, agrupado por tipo
const TIPOS_USO = {
    figurinhas: ['figurinha', 'fig', 'f', 'sticker', 's', 'print', 'citar', 'quote'],
    sorteios: ['sorteio', 'roleta', 'sortear'],
    enquetes: ['enquete', 'enquete+', 'votacao', 'votação'],
    lembretes: ['lembrar', 'lembrete', 'lembra'],
    transmissoes: ['transmitir', 'live']
};

function uso(ano) {
    const porPessoa = new Map();
    for (const r of all('zap', 'SELECT quem, cmd, n FROM uso WHERE ano = ?', ano)) {
        if (!porPessoa.has(r.quem)) porPessoa.set(r.quem, { total: 0 });
        const u = porPessoa.get(r.quem);
        u.total += r.n;
        for (const [tipo, cmds] of Object.entries(TIPOS_USO)) {
            if (cmds.includes(r.cmd)) u[tipo] = (u[tipo] ?? 0) + r.n;
        }
    }
    return porPessoa;
}

// Prêmios do ano: cada um vai para uma pessoa só
const PREMIOS = [
    { id: 'cinefilo', emoji: '🎬', titulo: 'Cinéfilo do Ano', valor: p => p.filmes?.n, texto: v => `${v} filmes e séries avaliados` },
    { id: 'gamer', emoji: '🎮', titulo: 'Gamer do Ano', valor: p => p.jogos?.n, texto: v => `${v} jogos avaliados` },
    { id: 'xp', emoji: '⚡', titulo: 'Lenda do XP', valor: p => p.xp && p.xp.level * 10_000 + p.xp.xp, texto: (v, p) => `nível ${p.xp.level} no RGDB` },
    { id: 'campeao', emoji: '🏆', titulo: 'Campeão do Bolão', valor: p => p.bolao?.posicao === 1 && p.bolao.pontos > 0 ? p.bolao.pontos : null, texto: v => `${v} pontos` },
    { id: 'vidente', emoji: '🔮', titulo: 'Vidente', valor: p => p.bolao?.exatos, texto: v => `${v} placar${v > 1 ? 'es' : ''} exato${v > 1 ? 's' : ''}` },
    { id: 'critico', emoji: '😈', titulo: 'Crítico Implacável', menor: true, valor: p => p.notasDadas >= 8 ? p.mediaGeral : null, texto: v => `média ${v.toFixed(1)} nas notas` },
    { id: 'coracao', emoji: '😇', titulo: 'Coração Mole', valor: p => p.notasDadas >= 8 ? p.mediaGeral : null, texto: v => `média ${v.toFixed(1)} nas notas` },
    { id: 'docontra', emoji: '🙃', titulo: 'Do Contra', valor: p => p.divergencia, texto: v => `erra o gosto do grupo por ${v.toFixed(1)} ponto${v >= 2 ? 's' : ''} em média` },
    { id: 'rebanho', emoji: '🐑', titulo: 'Voz do Povo', menor: true, valor: p => p.divergencia, texto: v => `nota quase igual à do grupo (±${v.toFixed(1)})` },
    { id: 'figurinhas', emoji: '🖼️', titulo: 'Rei das Figurinhas', valor: p => p.uso?.figurinhas, texto: v => `${v} figurinhas criadas` },
    { id: 'sorteios', emoji: '🎲', titulo: 'Dono da Roleta', valor: p => p.uso?.sorteios, texto: v => `${v} sorteios` },
    { id: 'enquetes', emoji: '🗳️', titulo: 'Democracia', valor: p => p.uso?.enquetes, texto: v => `${v} enquetes abertas` },
    { id: 'lembretes', emoji: '⏰', titulo: 'Agenda Humana', valor: p => p.uso?.lembretes, texto: v => `${v} lembretes marcados` },
    { id: 'transmissoes', emoji: '📺', titulo: 'Streamer do Regresso', valor: p => p.uso?.transmissoes, texto: v => `${v} salas abertas no Anti Janja` }
];

function darPremios(pessoas) {
    const premios = [];
    const ganhos = new Map();  // ninguém leva mais de 3, para espalhar
    for (const pr of PREMIOS) {
        const candidatos = pessoas
            .map(p => ({ p, v: pr.valor(p) }))
            .filter(c => c.v != null && c.v > 0)
            .sort((a, b) => (pr.menor ? a.v - b.v : b.v - a.v));
        // Prêmios de "mais X" exigem um mínimo para não premiar 1 uso
        const minimo = ['cinefilo', 'gamer', 'figurinhas', 'sorteios', 'enquetes', 'lembretes', 'transmissoes'].includes(pr.id) ? 2 : 0;
        const vencedor = candidatos.find(c => c.v >= minimo && (ganhos.get(c.p.id) ?? 0) < 3);
        if (!vencedor) continue;
        ganhos.set(vencedor.p.id, (ganhos.get(vencedor.p.id) ?? 0) + 1);
        const premio = { ...pr, quem: vencedor.p, descricao: pr.texto(vencedor.v, vencedor.p) };
        premios.push(premio);
        vencedor.p.premios.push(premio);
    }
    return premios;
}

// Título de quem não ganhou prêmio, pelo que a pessoa mais fez
function persona(p) {
    if (p.premios.length) return p.premios[0];
    const f = p.filmes?.n ?? 0, j = p.jogos?.n ?? 0, b = p.bolao?.palpites ?? 0, u = p.uso?.total ?? 0;
    const maior = Math.max(f, j, b, u);
    if (maior === 0) return { emoji: '👻', titulo: 'Fantasma do Grupo', descricao: 'quase não apareceu nos bots' };
    if (maior === f) return { emoji: '🍿', titulo: 'Crítico de Sofá', descricao: `${f} filmes e séries avaliados` };
    if (maior === j) return { emoji: '🕹️', titulo: 'Jogador de Fim de Semana', descricao: `${j} jogos avaliados` };
    if (maior === b) return { emoji: '⚽', titulo: 'Palpiteiro de Plantão', descricao: `${b} palpites no bolão` };
    return { emoji: '💬', titulo: 'Resenheiro', descricao: `${u} comandos no Zap` };
}

export function calcular(ano = anoWrapped()) {
    const filmes = avaliacoes('rmdb', 'votos_filmes', 'avaliacoes_filmes', 'movie_id', true);
    const jogos = avaliacoes('rgdb', 'votos_jogos', 'avaliacoes_jogos', 'game_id', false);
    const b = bolao(ano);
    const usoAno = uso(ano);

    // Nome: o do vínculo do Zap (nome do Discord), senão o do bot de aniversários, senão o usuário dos votos
    const nomes = new Map();
    const aniversarios = new Map(all('aniv', 'SELECT user_id, name, birthday FROM birthdays').map(r => [r.user_id, r]));
    for (const [id, a] of aniversarios) if (a.name) nomes.set(id, a.name);
    for (const r of all('zap', 'SELECT discord_id, nome FROM vinculos WHERE nome IS NOT NULL')) nomes.set(r.discord_id, r.nome);
    const xp = new Map(all('rgdb', 'SELECT user_id, username, xp, level FROM usuarios').map(r => [r.user_id, r]));
    const times = new Map(all('bolao', 'SELECT discord_id, time_nome FROM times_favoritos').map(r => [r.discord_id, r.time_nome]));

    const ids = new Set([...filmes.pessoas.keys(), ...jogos.pessoas.keys(), ...b.ranking.map(r => r.user_id),
        ...[...usoAno.keys()].filter(q => !q.includes('@')), ...[...xp.keys()].filter(id => xp.get(id).xp > 0 || xp.get(id).level > 1)]);

    const pessoas = [...ids].map(id => {
        const f = filmes.pessoas.get(id), j = jogos.pessoas.get(id);
        const notasDadas = (f?.n ?? 0) + (j?.n ?? 0);
        const divs = [f, j].filter(x => x?.divergencia != null);
        return {
            id,
            nome: nomes.get(id) || f?.nomeUsuario || j?.nomeUsuario || xp.get(id)?.username ||
                b.ranking.find(r => r.user_id === id)?.nome || 'Alguém',
            filmes: f, jogos: j,
            xp: xp.get(id),
            bolao: b.ranking.find(r => r.user_id === id),
            time: times.get(id),
            aniversario: aniversarios.get(id)?.birthday,
            uso: usoAno.get(id),
            notasDadas,
            mediaGeral: notasDadas ? ((f?.media ?? 0) * (f?.n ?? 0) + (j?.media ?? 0) * (j?.n ?? 0)) / notasDadas : null,
            divergencia: divs.length ? divs.reduce((s, x) => s + x.divergencia, 0) / divs.length : null,
            premios: []
        };
    }).filter(p => p.notasDadas || p.bolao || p.uso || p.xp)
        .sort((a, c) => (c.notasDadas + (c.bolao?.palpites ?? 0)) - (a.notasDadas + (a.bolao?.palpites ?? 0)));

    const premios = darPremios(pessoas);
    for (const p of pessoas) p.persona = persona(p);

    return {
        ano,
        previa: new Date().getMonth() < 11 && ano === new Date().getFullYear(),
        filmes, jogos, bolao: b, pessoas, premios,
        totalNotas: filmes.totalVotos + jogos.totalVotos,
        totalPalpites: b.ranking.reduce((s, r) => s + r.palpites, 0),
        totalUso: [...usoAno.values()].reduce((s, u) => s + u.total, 0)
    };
}

// ---------- Capas (TMDB e RAWG) ----------
// Os bancos não guardam pôster, então busca nas APIs só para o que aparece na página (com cache em memória).
const capas = new Map();   // 'f:<id>' | 'j:<id>' -> url ou null
const normal = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');

async function json(url) {
    const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
    return r.ok ? r.json() : null;
}

async function buscarCapa(chave, item) {
    if (chave.startsWith('f:')) {
        if (!config.tmdbKey) return null;
        // O id pode ser de filme ou de série: confere pelo título
        const tentativas = [];
        for (const tipo of ['movie', 'tv']) {
            const r = await json(`https://api.themoviedb.org/3/${tipo}/${item.id}?api_key=${config.tmdbKey}&language=pt-BR`);
            if (r?.poster_path) tentativas.push({ titulo: r.title || r.name, url: `https://image.tmdb.org/t/p/w342${r.poster_path}` });
        }
        return (tentativas.find(t => normal(t.titulo) === normal(item.title)) ?? tentativas[0])?.url ?? null;
    }
    if (!config.rawgKey) return null;
    const r = await json(`https://api.rawg.io/api/games/${item.id}?key=${config.rawgKey}`);
    return r?.background_image?.replace('/media/games/', '/media/crop/600/400/games/') ?? null;
}

export async function completarCapas(d) {
    const itens = [];
    const add = (tipo, item) => item?.id != null && itens.push([`${tipo}:${item.id}`, item]);
    for (const [tipo, g] of [['f', d.filmes], ['j', d.jogos]]) {
        [...g.top, ...g.piores, g.polemico, g.maisVotado].forEach(x => add(tipo, x));
    }
    for (const p of d.pessoas) {
        [p.filmes?.favorito, p.filmes?.pior, p.filmes?.brigou].forEach(x => add('f', x));
        [p.jogos?.favorito, p.jogos?.pior, p.jogos?.brigou].forEach(x => add('j', x));
    }
    const faltando = [...new Map(itens.filter(([k]) => !capas.has(k))).entries()];
    // Até 4 buscas ao mesmo tempo; o que não der tempo fica sem capa e entra na próxima visita
    const fila = [...faltando];
    const trabalhador = async () => {
        // Erro de rede não entra no cache (tenta de novo na próxima visita); "não tem capa" entra
        for (let x = fila.shift(); x; x = fila.shift()) {
            try { capas.set(x[0], await buscarCapa(...x)); } catch { /* tenta depois */ }
        }
    };
    await Promise.race([Promise.all([1, 2, 3, 4].map(trabalhador)), new Promise(r => setTimeout(r, 6000))]);
    for (const [k, item] of itens) if (capas.get(k)) item.poster = capas.get(k);
}

// Cache curto: a página e o cartão leem tudo dos bancos
let cache = null;
export function dadosWrapped() {
    if (!cache || Date.now() - cache.quando > 5 * 60_000) cache = { quando: Date.now(), dados: calcular() };
    return cache.dados;
}

// ---------- Texto para o Zap ----------
const n1 = v => Number(v).toFixed(1);

export function textoPessoa(d, p) {
    const linhas = [`🎁 *Regresso Wrapped ${d.ano}* — ${p.nome}`, `${p.persona.emoji} Você é *${p.persona.titulo}* (${p.persona.descricao})`];
    if (p.filmes) linhas.push(`🎬 ${p.filmes.n} filmes/séries · média ${n1(p.filmes.media)} · favorito: ${p.filmes.favorito.title}`);
    if (p.jogos) linhas.push(`🎮 ${p.jogos.n} jogos · média ${n1(p.jogos.media)} · favorito: ${p.jogos.favorito.title}`);
    if (p.bolao) linhas.push(`⚽ Bolão: ${p.bolao.pontos} pts, ${p.bolao.posicao}º lugar, ${p.bolao.exatos} exato(s)`);
    if (p.premios.length > 1) linhas.push(`🏅 Prêmios: ${p.premios.map(x => `${x.emoji} ${x.titulo}`).join(', ')}`);
    linhas.push(`\n👉 Retrospectiva completa: ${URL_BASE}/wrapped/${p.id}`);
    return linhas.join('\n');
}

export function textoGrupo(d) {
    const linhas = [`🎁 *Regresso Wrapped ${d.ano}*${d.previa ? ' (prévia)' : ''}`,
        `${d.totalNotas} notas · ${d.filmes.totalItens} filmes/séries · ${d.jogos.totalItens} jogos · ${d.pessoas.length} pessoas`];
    if (d.filmes.top[0]) linhas.push(`🎬 Filme do ano: *${d.filmes.top[0].title}* (⭐ ${n1(d.filmes.top[0].nota)})`);
    if (d.jogos.top[0]) linhas.push(`🎮 Jogo do ano: *${d.jogos.top[0].title}* (⭐ ${n1(d.jogos.top[0].nota)})`);
    if (d.premios.length) {
        linhas.push('', '*🏅 Prêmios*');
        for (const pr of d.premios) linhas.push(`${pr.emoji} ${pr.titulo}: *${pr.quem.nome}* — ${pr.descricao}`);
    }
    linhas.push('', `👉 ${URL_BASE}/wrapped`, `Manda *!wrapped eu* pra ver o seu.`);
    return linhas.join('\n');
}

// ---------- Cartões (PNG) ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// A fonte do cartão não tem emoji: tira emoji e corta textos longos
const limpo = (s, max = 30) => {
    const t = String(s ?? '').replace(/\p{Extended_Pictographic}|️|‍/gu, '').trim();
    return t.length > max ? `${t.slice(0, max - 1).trim()}…` : t;
};

function svgBase(conteudo, cor1, cor2) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350" viewBox="0 0 1080 1350">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${cor1}"/><stop offset="1" stop-color="${cor2}"/></linearGradient></defs>
<rect width="1080" height="1350" fill="url(#g)"/>
<circle cx="980" cy="120" r="260" fill="#fff" opacity="0.06"/><circle cx="80" cy="1260" r="320" fill="#fff" opacity="0.05"/>
<g font-family="DejaVu Sans" font-weight="bold" fill="#fff">${conteudo}</g></svg>`;
}

const caixa = (x, y, numero, legenda) =>
    `<rect x="${x}" y="${y}" width="470" height="200" rx="28" fill="#000" opacity="0.22"/>
<text x="${x + 36}" y="${y + 108}" font-size="84">${esc(numero)}</text>
<text x="${x + 38}" y="${y + 160}" font-size="30" opacity="0.8">${esc(legenda)}</text>`;

function svgPessoa(d, p) {
    const c = [`<text x="80" y="140" font-size="36" opacity="0.8">REGRESSO WRAPPED ${d.ano}</text>`,
        `<text x="80" y="250" font-size="84">${esc(limpo(p.nome, 18))}</text>`,
        `<text x="80" y="340" font-size="46" fill="#ffe27a">${esc(limpo(p.persona.titulo, 34))}</text>`,
        `<text x="80" y="392" font-size="30" opacity="0.85">${esc(limpo(p.persona.descricao, 52))}</text>`,
        caixa(60, 460, p.filmes?.n ?? 0, 'filmes e séries'),
        caixa(550, 460, p.jogos?.n ?? 0, 'jogos'),
        caixa(60, 690, p.bolao ? `${p.bolao.pontos}` : '—', p.bolao ? `pts no bolão (${p.bolao.posicao}º)` : 'bolão'),
        caixa(550, 690, p.xp ? `nv ${p.xp.level}` : '—', 'XP nos games')];
    let y = 990;
    if (p.filmes?.favorito) {
        c.push(`<text x="80" y="${y}" font-size="30" opacity="0.75">FILME FAVORITO</text>`,
            `<text x="80" y="${y + 52}" font-size="44">${esc(limpo(p.filmes.favorito.title, 36))}</text>`);
        y += 130;
    }
    if (p.jogos?.favorito) {
        c.push(`<text x="80" y="${y}" font-size="30" opacity="0.75">JOGO FAVORITO</text>`,
            `<text x="80" y="${y + 52}" font-size="44">${esc(limpo(p.jogos.favorito.title, 36))}</text>`);
    }
    c.push(`<text x="80" y="1300" font-size="28" opacity="0.7">${esc(URL_BASE.replace(/^https?:\/\//, ''))}/wrapped</text>`);
    return svgBase(c.join('\n'), '#6a11cb', '#e8456b');
}

function svgGrupo(d) {
    const c = [`<text x="80" y="150" font-size="40" opacity="0.8">REGRESSO WRAPPED</text>`,
        `<text x="80" y="300" font-size="150">${d.ano}</text>`,
        caixa(60, 360, d.totalNotas, 'notas dadas'),
        caixa(550, 360, d.pessoas.length, 'pessoas nos bots'),
        caixa(60, 590, d.filmes.totalItens, 'filmes e séries'),
        caixa(550, 590, d.jogos.totalItens, 'jogos')];
    let y = 880;
    if (d.filmes.top[0]) {
        c.push(`<text x="80" y="${y}" font-size="30" opacity="0.75">FILME DO ANO</text>`,
            `<text x="80" y="${y + 52}" font-size="44">${esc(limpo(d.filmes.top[0].title, 30))} · ${n1(d.filmes.top[0].nota)}</text>`);
        y += 130;
    }
    if (d.jogos.top[0]) {
        c.push(`<text x="80" y="${y}" font-size="30" opacity="0.75">JOGO DO ANO</text>`,
            `<text x="80" y="${y + 52}" font-size="44">${esc(limpo(d.jogos.top[0].title, 30))} · ${n1(d.jogos.top[0].nota)}</text>`);
        y += 130;
    }
    const campeao = d.premios.find(p => p.id === 'campeao');
    if (campeao) {
        c.push(`<text x="80" y="${y}" font-size="30" opacity="0.75">CAMPEÃO DO BOLÃO</text>`,
            `<text x="80" y="${y + 52}" font-size="44">${esc(limpo(campeao.quem.nome, 22))} · ${esc(campeao.descricao)}</text>`);
    }
    c.push(`<text x="80" y="1300" font-size="28" opacity="0.7">${esc(URL_BASE.replace(/^https?:\/\//, ''))}/wrapped</text>`);
    return svgBase(c.join('\n'), '#0f2027', '#2c5364');
}

async function png(svg) {
    const { default: sharp } = await import('sharp');
    sharp.concurrency(1);
    return sharp(Buffer.from(svg)).png().toBuffer();
}

export const cartaoPessoa = (d, p) => png(svgPessoa(d, p));
export const cartaoGrupo = d => png(svgGrupo(d));

// ---------- Anúncio (AdSense) ----------
// Um bloco só, no último slide. Só aparece com o ID do bloco de anúncio configurado (não é segredo):
// AdSense → Anúncios → Por bloco de anúncios → Display → copiar o data-ad-slot.
const ADSENSE_CLIENTE = 'ca-pub-3476040476227672';
const ADSENSE_BLOCO = process.env.WRAPPED_AD_SLOT || '7564930340';   // bloco "Money"
const scriptAnuncio = () => (ADSENSE_BLOCO
    ? `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENTE}" crossorigin="anonymous"></script>` : '');
const blocoAnuncio = () => (ADSENSE_BLOCO ? `<div class="anuncio"><small>Publicidade · ajuda a manter os bots no ar</small>
<ins class="adsbygoogle" style="display:block" data-ad-client="${ADSENSE_CLIENTE}" data-ad-slot="${esc(ADSENSE_BLOCO)}" data-ad-format="auto" data-full-width-responsive="true"></ins>
<script>(adsbygoogle = window.adsbygoogle || []).push({});</script></div>` : '');

// ---------- Página web ----------
const CORES = [['#6a11cb', '#2575fc'], ['#e8456b', '#f7a13b'], ['#0f9b8e', '#1d4350'], ['#232526', '#5b2c83'],
    ['#ff512f', '#dd2476'], ['#1e3c72', '#2a5298'], ['#134e5e', '#71b280'], ['#41295a', '#2f0743']];

function slide(i, html) {
    const [a, b] = CORES[i % CORES.length];
    return `<section style="background:linear-gradient(160deg,${a},${b})"><div class="in">${html}</div></section>`;
}

const numero = (v, casas = 0) => `<span class="num" data-v="${Number(v)}" data-c="${casas}">${Number(v).toFixed(casas)}</span>`;
const poster = item => (item?.poster ? `<img class="poster" src="${esc(item.poster)}" alt="" loading="lazy">` : '');
const nomeItem = item => `<b>${esc(item.title)}</b>`;

function pagina(titulo, slides, rodape = '') {
    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">${scriptAnuncio()}
<title>${esc(titulo)}</title>
<meta property="og:title" content="${esc(titulo)}"><meta property="og:description" content="A retrospectiva do ano no Regresso">
<style>
*{box-sizing:border-box;margin:0}html,body{height:100%;background:#000;color:#fff;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{height:100%;overflow-y:auto;scroll-snap-type:y mandatory}
section{min-height:100%;scroll-snap-align:start;display:flex;align-items:center;justify-content:center;padding:48px 24px;position:relative}
.in{max-width:560px;width:100%;opacity:0;transform:translateY(30px);transition:all .7s ease}
section.vis .in{opacity:1;transform:none}
.k{font-size:14px;letter-spacing:.18em;text-transform:uppercase;opacity:.75;margin-bottom:12px}
h1{font-size:clamp(40px,11vw,76px);line-height:1;font-weight:900;margin-bottom:16px}
h2{font-size:clamp(28px,7vw,44px);line-height:1.1;font-weight:800;margin-bottom:16px}
p{font-size:19px;line-height:1.45;opacity:.92;margin:10px 0}
.num{font-size:clamp(64px,20vw,120px);font-weight:900;display:block;line-height:1}
.big{font-size:56px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:20px}
.card{background:rgba(0,0,0,.22);border-radius:18px;padding:16px}.card .num{font-size:44px}.card small{opacity:.8}
.lista{list-style:none;padding:0;margin-top:16px}.lista li{display:flex;gap:12px;align-items:center;background:rgba(0,0,0,.2);border-radius:14px;padding:10px 14px;margin:8px 0;font-size:17px}
.lista .pos{font-weight:900;width:28px;opacity:.8}.lista .nota{margin-left:auto;font-weight:800}
.poster{width:120px;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.4);margin:12px 8px 0 0}
.mini{width:42px;border-radius:6px}
.emoji{font-size:72px;display:block;margin-bottom:8px}
a{color:#fff}.pessoas a{display:inline-block;background:rgba(255,255,255,.15);padding:8px 14px;border-radius:999px;margin:4px;text-decoration:none}
.dica{position:absolute;bottom:18px;left:0;right:0;text-align:center;opacity:.6;font-size:14px;animation:pula 1.6s infinite}
@keyframes pula{50%{transform:translateY(6px)}}
.anuncio{overflow:hidden;max-width:100%;margin-top:28px;background:rgba(0,0,0,.25);border-radius:14px;padding:10px;min-height:120px}.anuncio small{display:block;opacity:.6;font-size:12px;margin-bottom:6px}
.tag{display:inline-block;background:#ffe27a;color:#222;font-weight:800;border-radius:999px;padding:4px 12px;font-size:14px}
</style></head><body><main>${slides.join('\n')}${rodape}</main>
<script>
const io=new IntersectionObserver(es=>es.forEach(e=>{if(!e.isIntersecting||e.target.classList.contains('vis'))return;
e.target.classList.add('vis');e.target.querySelectorAll('.num').forEach(n=>{const v=+n.dataset.v,c=+n.dataset.c,t0=performance.now();
const f=t=>{const k=Math.max(0,Math.min(1,(t-t0)/1100));n.textContent=(v*(1-Math.pow(1-k,3))).toFixed(c);if(k<1)requestAnimationFrame(f)};requestAnimationFrame(f)})}),{threshold:.35});
document.querySelectorAll('section').forEach(s=>io.observe(s));
</script></body></html>`;
}

function comparar(media, mediaGrupo) {
    if (media == null || mediaGrupo == null) return '';
    const dif = media - mediaGrupo;
    if (Math.abs(dif) < 0.3) return 'Bem na média do grupo.';
    return dif < 0
        ? `${n1(-dif)} ponto${-dif >= 2 ? 's' : ''} mais exigente que o grupo.`
        : `${n1(dif)} ponto${dif >= 2 ? 's' : ''} mais bonzinho que o grupo.`;
}

export function paginaPessoa(d, p) {
    const s = [];
    let i = 0;
    s.push(slide(i++, `<div class="k">Regresso Wrapped ${d.ano}${d.previa ? ' · prévia' : ''}</div>
<h1>E aí, ${esc(p.nome)}.</h1><p>Bora ver o que você aprontou nos bots do Regresso esse ano.</p><div class="dica">↓ desliza</div>`));

    if (p.filmes) {
        const pct = Math.round((p.filmes.n / d.filmes.totalVotos) * 100);
        s.push(slide(i++, `<div class="k">Filmes e séries</div>${numero(p.filmes.n)}<h2>notas no RMDB</h2>
<p>Isso é <b>${pct}%</b> de todas as notas de filme do grupo.</p>
<p>Sua média: <b>${n1(p.filmes.media)}</b>. ${comparar(p.filmes.media, d.filmes.media)}</p>`));
        s.push(slide(i++, `<div class="k">Seu favorito</div>${poster(p.filmes.favorito)}<h2>${esc(p.filmes.favorito.title)}</h2>
<p>Você deu <b>${n1(p.filmes.favorito.score)}</b> (o grupo deu ${n1(p.filmes.favorito.grupo)}).</p>
${p.filmes.pior ? `<p style="margin-top:28px">E o que você menos curtiu: <b>${esc(p.filmes.pior.title)}</b> — nota ${n1(p.filmes.pior.score)}.</p>` : ''}`));
    }

    if (p.jogos) {
        s.push(slide(i++, `<div class="k">Games</div>${numero(p.jogos.n)}<h2>jogos avaliados</h2>
<p>Média <b>${n1(p.jogos.media)}</b>. ${comparar(p.jogos.media, d.jogos.media)}</p>
${poster(p.jogos.favorito)}<p>Favorito: <b>${esc(p.jogos.favorito.title)}</b> (${n1(p.jogos.favorito.score)})</p>
${p.xp ? `<p><span class="tag">Nível ${p.xp.level} no RGDB</span></p>` : ''}`));
    }

    const brigas = [p.filmes?.brigou, p.jogos?.brigou].filter(Boolean).sort((a, b) => Math.abs(b.dif) - Math.abs(a.dif));
    if (brigas[0]) {
        const b = brigas[0];
        s.push(slide(i++, `<div class="k">Sua maior treta</div>${b.poster ? poster(b) : `<span class="emoji">${b.dif < 0 ? '🔥' : '🫶'}</span>`}
<h2>${esc(b.title)}</h2><p>Você deu <b>${n1(b.score)}</b>. O resto do grupo deu <b>${n1(b.outros)}</b>.</p>
<p>${b.dif < 0 ? 'Ninguém entendeu o ódio.' : 'Você defendeu sozinho.'}</p>`));
    }

    if (p.bolao) {
        s.push(slide(i++, `<div class="k">Bolão do Brasileirão ${d.bolao.temporada}</div>${numero(p.bolao.pontos)}<h2>pontos</h2>
<div class="grid"><div class="card">${numero(p.bolao.posicao)}<small>lugar</small></div>
<div class="card">${numero(p.bolao.exatos)}<small>placares exatos</small></div>
<div class="card">${numero(p.bolao.palpites)}<small>palpites</small></div>
<div class="card">${numero(p.bolao.zerados)}<small>zerados</small></div></div>
${p.time ? `<p style="margin-top:18px">Coração: <b>${esc(p.time)}</b></p>` : ''}`));
    }

    if (p.uso?.total) {
        const u = p.uso;
        const itens = [['figurinhas', 'figurinhas'], ['sorteios', 'sorteios'], ['enquetes', 'enquetes'], ['lembretes', 'lembretes'], ['transmissoes', 'salas no Anti Janja']]
            .filter(([k]) => u[k]).map(([k, t]) => `<div class="card">${numero(u[k])}<small>${t}</small></div>`).join('');
        s.push(slide(i++, `<div class="k">Resenha no Zap</div>${numero(u.total)}<h2>comandos no bot</h2>${itens ? `<div class="grid">${itens}</div>` : ''}`));
    }

    s.push(slide(i++, `<div class="k">Seu título do ano</div><span class="emoji">${p.persona.emoji}</span>
<h1>${esc(p.persona.titulo)}</h1><p>${esc(p.persona.descricao)}</p>
${p.premios.length > 1 ? `<p style="margin-top:20px">E ainda levou: ${p.premios.slice(1).map(x => `${x.emoji} <b>${esc(x.titulo)}</b>`).join(' · ')}</p>` : ''}`));

    s.push(slide(i++, `<div class="k">É isso</div><h2>Valeu por fazer parte do Regresso em ${d.ano}.</h2>
<p><a href="${URL_BASE}/wrapped">Ver a retrospectiva do grupo →</a></p>${blocoAnuncio()}`));
    return pagina(`Regresso Wrapped ${d.ano} — ${p.nome}`, s);
}

export function paginaGrupo(d) {
    const s = [];
    let i = 0;
    s.push(slide(i++, `<div class="k">Regresso Wrapped${d.previa ? ' · prévia' : ''}</div><h1 style="font-size:clamp(80px,26vw,160px)">${d.ano}</h1>
<p>O ano do grupo nos bots: filmes, jogos, bolão e resenha.</p><div class="dica">↓ desliza</div>`));

    s.push(slide(i++, `<div class="k">Em números</div><div class="grid">
<div class="card">${numero(d.totalNotas)}<small>notas dadas</small></div>
<div class="card">${numero(d.filmes.totalItens)}<small>filmes e séries</small></div>
<div class="card">${numero(d.jogos.totalItens)}<small>jogos</small></div>
<div class="card">${numero(d.totalPalpites)}<small>palpites no bolão</small></div></div>
<p style="margin-top:18px">Nota média do grupo: filmes <b>${d.filmes.media != null ? n1(d.filmes.media) : '—'}</b>, jogos <b>${d.jogos.media != null ? n1(d.jogos.media) : '—'}</b>.</p>`));

    const top = (lista, titulo, k) => lista.length ? slide(i++, `<div class="k">${k}</div><h2>${titulo}</h2><ul class="lista">${lista.map((x, j) =>
        `<li><span class="pos">${j + 1}</span>${x.poster ? `<img class="mini" src="${esc(x.poster)}" alt="">` : ''}<span>${esc(x.title)}</span><span class="nota">${n1(x.nota)}</span></li>`).join('')}</ul>`) : '';
    s.push(top(d.filmes.top, 'Os filmes do ano', 'Top 5 RMDB'));
    s.push(top(d.jogos.top, 'Os jogos do ano', 'Top 5 RGDB'));

    const extremos = [];
    if (d.filmes.polemico) extremos.push(`<p>🔥 Mais polêmico: ${nomeItem(d.filmes.polemico)} — notas variando ±${n1(d.filmes.polemico.desvio)}</p>`);
    if (d.filmes.piores[0] && d.filmes.piores[0].id !== d.filmes.polemico?.id) extremos.push(`<p>🗑️ O pior filme: ${nomeItem(d.filmes.piores[0])} (${n1(d.filmes.piores[0].nota)})</p>`);
    if (d.jogos.polemico) extremos.push(`<p>🔥 Jogo que dividiu o grupo: ${nomeItem(d.jogos.polemico)} (±${n1(d.jogos.polemico.desvio)})</p>`);
    if (d.jogos.piores[0] && d.jogos.piores[0].id !== d.jogos.polemico?.id) extremos.push(`<p>🗑️ O pior jogo: ${nomeItem(d.jogos.piores[0])} (${n1(d.jogos.piores[0].nota)})</p>`);
    if (d.filmes.maisVotado) extremos.push(`<p>👀 O que mais gente viu: ${nomeItem(d.filmes.maisVotado)} (${d.filmes.maisVotado.n} notas)</p>`);
    if (extremos.length) s.push(slide(i++, `<div class="k">Treta e unanimidade</div><h2>O que dividiu o grupo</h2>${extremos.join('')}`));

    if (d.bolao.ranking.length) {
        s.push(slide(i++, `<div class="k">Bolão ${d.bolao.temporada}</div><h2>${d.previa ? 'Classificação até agora' : 'Classificação final'}</h2><ul class="lista">${d.bolao.ranking.slice(0, 8).map(r => {
            const p = d.pessoas.find(x => x.id === r.user_id);
            return `<li><span class="pos">${r.posicao}</span><span>${esc(p?.nome ?? r.nome)}</span><span class="nota">${r.pontos} pts</span></li>`;
        }).join('')}</ul>`));
    }

    if (d.premios.length) {
        s.push(slide(i++, `<div class="k">Prêmios</div><h2>Os destaques de ${d.ano}</h2><ul class="lista">${d.premios.map(pr =>
            `<li><span style="font-size:28px">${pr.emoji}</span><span><b>${esc(pr.titulo)}</b><br><small>${esc(pr.quem.nome)} · ${esc(pr.descricao)}</small></span></li>`).join('')}</ul>`));
    }

    s.push(slide(i++, `<div class="k">E você?</div><h2>Veja a sua retrospectiva</h2><div class="pessoas">${d.pessoas.map(p =>
        `<a href="${URL_BASE}/wrapped/${encodeURIComponent(p.id)}">${p.persona.emoji} ${esc(p.nome)}</a>`).join('')}</div>
<p style="margin-top:18px;font-size:15px;opacity:.7">Notas de filmes e jogos contam desde o começo dos bots; bolão e comandos do Zap contam o ano de ${d.ano}.</p>${blocoAnuncio()}`));
    return pagina(`Regresso Wrapped ${d.ano}`, s.filter(Boolean));
}

// ---------- Rotas HTTP (chamadas pelo servidor do index.js) ----------
export async function rotaWrapped(req, res) {
    const url = new URL(req.url, 'http://x');
    const partes = url.pathname.split('/').filter(Boolean);   // ['wrapped', id?]
    if (partes[0] === 'robots.txt') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        // Só o robô do AdSense pode ler (para escolher anúncios); buscadores continuam bloqueados (as páginas têm dados da galera)
        res.end('User-agent: Mediapartners-Google\nAllow: /\n\nUser-agent: *\nDisallow: /\n');
        return true;
    }
    if (partes[0] !== 'wrapped') return false;

    const d = dadosWrapped();
    const enviar = (status, tipo, corpo) => {
        res.writeHead(status, { 'Content-Type': tipo, 'Cache-Control': 'public, max-age=300' });
        res.end(corpo);
    };
    const alvo = partes[1] ? decodeURIComponent(partes[1]) : null;

    if (!alvo) {
        await completarCapas(d);
        return enviar(200, 'text/html; charset=utf-8', paginaGrupo(d)), true;
    }
    if (alvo === 'grupo.png') return enviar(200, 'image/png', await cartaoGrupo(d)), true;

    const id = alvo.replace(/\.png$/, '');
    const p = d.pessoas.find(x => x.id === id);
    if (!p) return enviar(404, 'text/html; charset=utf-8', pagina('Não encontrado', [slide(3,
        `<h2>Não achei essa pessoa no Wrapped.</h2><p><a href="${URL_BASE}/wrapped">Ver a retrospectiva do grupo →</a></p>`)])), true;
    if (alvo.endsWith('.png')) return enviar(200, 'image/png', await cartaoPessoa(d, p)), true;
    await completarCapas(d);
    return enviar(200, 'text/html; charset=utf-8', paginaPessoa(d, p)), true;
}

// ---------- Comando e post automático no grupo ----------
export const COMANDOS_WRAPPED = ['wrapped', 'retrospectiva'];

// Manda o cartão em imagem com o texto; se a imagem falhar (sharp ausente), manda só o texto
async function enviarCartao(sock, chat, gerar, texto, opcoes = {}) {
    let imagem = null;
    try {
        imagem = await gerar();
    } catch (e) {
        console.error('Wrapped: cartão não gerado:', e.message);
    }
    await sock.sendMessage(chat, imagem ? { image: imagem, caption: texto } : { text: texto }, opcoes);
}

// !wrapped → do grupo · !wrapped eu → o seu (no privado, o seu é o padrão)
export async function tratarWrapped(sock, msg, ids, texto) {
    const chat = msg.key.remoteJid;
    const grupo = chat.endsWith('@g.us');
    const arg = texto.trim().split(/\s+/).slice(1).join(' ').toLowerCase();
    const d = dadosWrapped();

    if (arg === 'grupo' || (grupo && !['eu', 'meu', 'minha', 'me'].includes(arg))) {
        return enviarCartao(sock, chat, () => cartaoGrupo(d), textoGrupo(d), { quoted: msg });
    }
    const v = quemE(ids);
    if (!v) {
        return sock.sendMessage(chat, { text: 'Pra ver o seu Wrapped, vincule seu Discord primeiro: use /zap no Discord e depois !vincular CÓDIGO aqui.' }, { quoted: msg });
    }
    const p = d.pessoas.find(x => x.id === v.discord_id);
    if (!p) return sock.sendMessage(chat, { text: 'Ainda não achei nada seu nos bots este ano. Dá umas notas aí! 😅' }, { quoted: msg });
    return enviarCartao(sock, chat, () => cartaoPessoa(d, p), textoPessoa(d, p), { quoted: msg });
}

// Post automático no grupo, uma vez por ano (padrão: 20/12 às 20h)
const [DIA_POST, MES_POST] = (process.env.WRAPPED_DIA || '20/12').split('/').map(Number);
const HORA_POST = Number(process.env.WRAPPED_HORA ?? 20);

export async function verificarWrapped(sock) {
    if (!config.grupoId) return;
    const agora = new Date();
    const data = new Date(agora.getFullYear(), MES_POST - 1, DIA_POST, HORA_POST);
    // Só no dia marcado ou nos dias seguintes até o fim do ano (se o bot estava fora no dia)
    if (agora < data || agora.getMonth() !== MES_POST - 1) return;
    const chave = `wrapped:${agora.getFullYear()}`;
    if (getEstado(chave)) return;
    setEstado(chave, agora.toISOString());   // marca antes, para nunca postar duas vezes
    cache = null;
    const d = dadosWrapped();
    await enviarCartao(sock, config.grupoId, () => cartaoGrupo(d), textoGrupo(d));
    console.log(`🎁 Wrapped ${d.ano} postado no grupo.`);
}
