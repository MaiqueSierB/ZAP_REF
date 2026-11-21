// Acesso aos bancos SQLite dos bots (RMDB, RGDB, bolão) e ao banco próprio do Zap.
// Todos ficam na mesma conta da Hostinger; o busy_timeout evita conflito quando
// o bot do Discord e o do Zap escrevem ao mesmo tempo.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import config from './config.js';

function abrir(arquivo, { criar = false } = {}) {
    if (!criar && !fs.existsSync(arquivo)) return null;
    fs.mkdirSync(path.dirname(arquivo), { recursive: true });
    const db = new Database(arquivo);
    db.pragma('busy_timeout = 5000');
    return db;
}

const cache = {};
function db(nome) {
    if (cache[nome]) return cache[nome];
    const arquivo = { zap: config.zapDb, rmdb: config.rmdbDb, rgdb: config.rgdbDb, bolao: config.bolaoDb }[nome];
    const aberto = abrir(arquivo, { criar: nome === 'zap' });
    if (aberto) cache[nome] = aberto;
    return aberto;
}

// ---------- Zap: vínculos com o Discord ----------
db('zap').exec(`
    CREATE TABLE IF NOT EXISTS vinculos (
        zap_id      TEXT PRIMARY KEY,   -- id do remetente no WhatsApp (@s.whatsapp.net ou @lid)
        discord_id  TEXT NOT NULL,
        nome        TEXT,
        criado      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS codigos (
        codigo      TEXT PRIMARY KEY,   -- gerado pelo /zap no Discord
        discord_id  TEXT NOT NULL,
        nome        TEXT,
        expira      INTEGER NOT NULL    -- epoch ms
    );
`);

export function quemE(zapIds) {
    for (const id of zapIds.filter(Boolean)) {
        const v = db('zap').prepare('SELECT * FROM vinculos WHERE zap_id = ?').get(id);
        if (v) return v;
    }
    return null;
}

export function vincular(codigo, zapIds) {
    const c = db('zap').prepare('SELECT * FROM codigos WHERE codigo = ?').get(codigo);
    if (!c || c.expira < Date.now()) return null;
    const ins = db('zap').prepare(`
        INSERT INTO vinculos (zap_id, discord_id, nome) VALUES (?, ?, ?)
        ON CONFLICT(zap_id) DO UPDATE SET discord_id = excluded.discord_id, nome = excluded.nome
    `);
    db('zap').transaction(() => {
        for (const id of zapIds.filter(Boolean)) ins.run(id, c.discord_id, c.nome);
        db('zap').prepare('DELETE FROM codigos WHERE codigo = ? OR expira < ?').run(codigo, Date.now());
    })();
    return c;
}

export function desvincular(zapIds) {
    const del = db('zap').prepare('DELETE FROM vinculos WHERE zap_id = ?');
    return zapIds.filter(Boolean).reduce((n, id) => n + del.run(id).changes, 0);
}

// ---------- RMDB (filmes e séries) ----------
export function votarFilme(discordId, nome, movieId, titulo, nota) {
    const d = db('rmdb');
    if (!d) throw new Error('banco do RMDB não encontrado');
    return d.transaction(() => {
        d.prepare(`
            INSERT INTO votos_filmes (movie_id, user_id, username, score) VALUES (?, ?, ?, ?)
            ON CONFLICT(movie_id, user_id) DO UPDATE SET score = excluded.score
        `).run(movieId, discordId, nome, nota);
        const s = d.prepare('SELECT AVG(score) AS avg, COUNT(*) AS total FROM votos_filmes WHERE movie_id = ?').get(movieId);
        d.prepare(`
            INSERT INTO avaliacoes_filmes (movie_id, title, server_score, vote_count) VALUES (?, ?, ?, ?)
            ON CONFLICT(movie_id) DO UPDATE SET server_score = excluded.server_score, vote_count = excluded.vote_count
        `).run(movieId, titulo, s.avg, s.total);
        return s;
    })();
}

export function notaFilme(movieId) {
    return db('rmdb')?.prepare('SELECT server_score, vote_count FROM avaliacoes_filmes WHERE movie_id = ?').get(movieId) ?? null;
}

export function topFilmes(n = 10) {
    return db('rmdb')?.prepare(`
        SELECT title, server_score, vote_count FROM avaliacoes_filmes
        ORDER BY server_score DESC, vote_count DESC LIMIT ?`).all(n) ?? [];
}

// ---------- RGDB (jogos) ----------
const XP = { joguei: { xp: 25, txt: 'Joguei' }, zerei: { xp: 50, txt: 'Zerei' }, platinei: { xp: 200, txt: 'Platinei/100%' } };
export const STATUS_JOGO = Object.keys(XP);

export function votarJogo(discordId, nome, gameId, titulo, nota, status = 'joguei') {
    const d = db('rgdb');
    if (!d) throw new Error('banco do RGDB não encontrado');
    const ganho = XP[status] ?? XP.joguei;
    return d.transaction(() => {
        d.prepare(`
            INSERT INTO votos_jogos (game_id, user_id, username, score) VALUES (?, ?, ?, ?)
            ON CONFLICT(game_id, user_id) DO UPDATE SET score = excluded.score
        `).run(gameId, discordId, nome, nota);
        const s = d.prepare('SELECT AVG(score) AS avg, COUNT(*) AS total FROM votos_jogos WHERE game_id = ?').get(gameId);
        d.prepare(`
            INSERT INTO avaliacoes_jogos (game_id, title, server_score, vote_count) VALUES (?, ?, ?, ?)
            ON CONFLICT(game_id) DO UPDATE SET server_score = excluded.server_score, vote_count = excluded.vote_count
        `).run(gameId, titulo, s.avg, s.total);

        // Mesma regra de XP do bot do Discord
        const u = d.prepare('SELECT * FROM usuarios WHERE user_id = ?').get(discordId);
        let xp = (u?.xp || 0) + ganho.xp;
        let level = u?.level || 1;
        while (xp >= level * 500) { xp -= level * 500; level++; }
        d.prepare(`
            INSERT INTO usuarios (user_id, username, xp, level) VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET xp = excluded.xp, level = excluded.level, username = excluded.username
        `).run(discordId, nome, xp, level);
        return { ...s, ganho: ganho.xp, status: ganho.txt, level };
    })();
}

export function notaJogo(gameId) {
    return db('rgdb')?.prepare('SELECT server_score, vote_count FROM avaliacoes_jogos WHERE game_id = ?').get(gameId) ?? null;
}

export function topJogos(n = 10) {
    return db('rgdb')?.prepare(`
        SELECT title, server_score, vote_count FROM avaliacoes_jogos
        ORDER BY server_score DESC, vote_count DESC LIMIT ?`).all(n) ?? [];
}

// ---------- Bolão ----------
const agora = () => new Date().toISOString();

export function bolaoAbertos(n = 10) {
    return db('bolao')?.prepare(`
        SELECT * FROM jogos WHERE status IN ('SCHEDULED','TIMED') AND data_utc > ?
        ORDER BY data_utc, id LIMIT ?`).all(agora(), n) ?? [];
}

export function bolaoPalpitar(jogoId, discordId, nome, casa, fora) {
    const d = db('bolao');
    if (!d) throw new Error('banco do bolão não encontrado');
    const j = d.prepare('SELECT * FROM jogos WHERE id = ?').get(jogoId);
    if (!j || !['SCHEDULED', 'TIMED'].includes(j.status) || j.data_utc <= agora()) return null;
    d.prepare(`
        INSERT INTO palpites (jogo_id, user_id, username, gols_casa, gols_fora, atualizado)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(jogo_id, user_id) DO UPDATE SET gols_casa = excluded.gols_casa, gols_fora = excluded.gols_fora,
            username = excluded.username, atualizado = excluded.atualizado
    `).run(jogoId, discordId, nome, casa, fora);
    return j;
}

export function bolaoMeus(discordId) {
    return db('bolao')?.prepare(`
        SELECT j.casa, j.fora, j.data_utc, j.status, j.gols_casa, j.gols_fora,
               p.gols_casa AS p_casa, p.gols_fora AS p_fora, p.pontos
        FROM palpites p JOIN jogos j ON j.id = p.jogo_id
        WHERE p.user_id = ? ORDER BY j.data_utc DESC LIMIT 10`).all(discordId) ?? [];
}

export function bolaoRanking(n = 10) {
    const d = db('bolao');
    if (!d) return [];
    const t = d.prepare('SELECT MAX(temporada) AS t FROM jogos').get()?.t;
    return d.prepare(`
        SELECT MAX(p.username) AS nome, COALESCE(SUM(p.pontos), 0) AS pontos,
               SUM(CASE WHEN p.pontos = 10 THEN 1 ELSE 0 END) AS exatos
        FROM palpites p JOIN jogos j ON j.id = p.jogo_id
        WHERE j.temporada = ? GROUP BY p.user_id
        ORDER BY pontos DESC, exatos DESC LIMIT ?`).all(t, n);
}
