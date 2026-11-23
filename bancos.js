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
    const arquivo = { zap: config.zapDb, rmdb: config.rmdbDb, rgdb: config.rgdbDb, bolao: config.bolaoDb, aniv: config.anivDb }[nome];
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
    CREATE TABLE IF NOT EXISTS aniv_enviados (
        user_id     TEXT NOT NULL,
        data        TEXT NOT NULL,      -- AAAA-MM-DD (Brasília)
        PRIMARY KEY (user_id, data)
    );
    -- Retrospectiva semanal: "foto" dos contadores no último envio, para calcular o que mudou na semana
    CREATE TABLE IF NOT EXISTS retro_foto (
        chave TEXT PRIMARY KEY,         -- f:<filme> j:<jogo> uf:<usuário filmes> uj:<usuário jogos>
        valor INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lembretes (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        chat    TEXT NOT NULL,
        autor   TEXT NOT NULL,              -- id do WhatsApp de quem pediu (para marcar)
        texto   TEXT NOT NULL,
        quando  INTEGER NOT NULL,           -- epoch ms
        enviado INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS estado (
        chave TEXT PRIMARY KEY,
        valor TEXT
    );
    -- Uso dos comandos por pessoa e ano (alimenta o Wrapped). quem = id do Discord se vinculado, senão o id do Zap
    CREATE TABLE IF NOT EXISTS uso (
        ano   INTEGER NOT NULL,
        quem  TEXT NOT NULL,
        cmd   TEXT NOT NULL,
        n     INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (ano, quem, cmd)
    );
    CREATE TABLE IF NOT EXISTS codigos (
        codigo      TEXT PRIMARY KEY,   -- gerado pelo /zap no Discord
        discord_id  TEXT NOT NULL,
        nome        TEXT,
        expira      INTEGER NOT NULL    -- epoch ms
    );
`);

// Acesso direto aos bancos (usado pelo Wrapped, que faz consultas próprias)
export const banco = db;

export function registrarUso(zapIds, cmd) {
    const quem = quemE(zapIds)?.discord_id ?? zapIds.find(Boolean);
    if (!quem) return;
    db('zap').prepare(`
        INSERT INTO uso (ano, quem, cmd, n) VALUES (?, ?, ?, 1)
        ON CONFLICT(ano, quem, cmd) DO UPDATE SET n = n + 1
    `).run(new Date().getFullYear(), quem, cmd);
}

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
        INSERT INTO palpites (jogo_id, user_id, username, gols_casa, gols_fora, atualizado, origem)
        VALUES (?, ?, ?, ?, ?, datetime('now'), 'zap')
        ON CONFLICT(jogo_id, user_id) DO UPDATE SET gols_casa = excluded.gols_casa, gols_fora = excluded.gols_fora,
            username = excluded.username, atualizado = excluded.atualizado, origem = excluded.origem
    `).run(jogoId, discordId, nome, casa, fora);
    return j;
}

// Palpites em jogos que ainda não começaram (para o !apagar)
export function bolaoPalpitesAbertos(discordId) {
    return db('bolao')?.prepare(`
        SELECT j.id, j.casa, j.fora, j.data_utc, p.gols_casa AS p_casa, p.gols_fora AS p_fora
        FROM palpites p JOIN jogos j ON j.id = p.jogo_id
        WHERE p.user_id = ? AND j.status IN ('SCHEDULED','TIMED') AND j.data_utc > ?
        ORDER BY j.data_utc LIMIT 15`).all(discordId, agora()) ?? [];
}

export function bolaoApagar(jogoId, discordId) {
    return db('bolao').prepare(`DELETE FROM palpites WHERE jogo_id = ? AND user_id = ?
        AND jogo_id IN (SELECT id FROM jogos WHERE status IN ('SCHEDULED','TIMED') AND data_utc > ?)`)
        .run(jogoId, discordId, agora()).changes > 0;
}

export function bolaoMeus(discordId) {
    return db('bolao')?.prepare(`
        SELECT j.casa, j.fora, j.data_utc, j.status, j.gols_casa, j.gols_fora,
               p.gols_casa AS p_casa, p.gols_fora AS p_fora, p.pontos, p.origem
        FROM palpites p JOIN jogos j ON j.id = p.jogo_id
        WHERE p.user_id = ? ORDER BY j.data_utc DESC LIMIT 10`).all(discordId) ?? [];
}

export function bolaoRanking(n = 10) {
    const d = db('bolao');
    if (!d) return [];
    const t = d.prepare('SELECT MAX(temporada) AS t FROM jogos').get()?.t;
    return d.prepare(`
        SELECT MAX(p.username) AS nome, COALESCE(SUM(p.pontos), 0) AS pontos,
               SUM(CASE WHEN p.pontos = 25 THEN 1 ELSE 0 END) AS exatos
        FROM palpites p JOIN jogos j ON j.id = p.jogo_id
        WHERE j.temporada = ? GROUP BY p.user_id
        ORDER BY pontos DESC, exatos DESC LIMIT ?`).all(t, n);
}

// ---------- Aniversários ----------
export function aniversariantesDoDia(ddmm, dataISO) {
    const d = db('aniv');
    if (!d) return [];
    return d.prepare('SELECT name, user_id, image_url FROM birthdays WHERE birthday = ?').all(ddmm)
        .filter(a => !db('zap').prepare('SELECT 1 FROM aniv_enviados WHERE user_id = ? AND data = ?').get(a.user_id, dataISO));
}

export function marcarAnivEnviado(userId, dataISO) {
    db('zap').prepare('INSERT OR IGNORE INTO aniv_enviados (user_id, data) VALUES (?, ?)').run(userId, dataISO);
}

// IDs do WhatsApp vinculados a uma conta do Discord (para marcar a pessoa)
export function zapIdsDe(discordId) {
    return db('zap').prepare('SELECT zap_id FROM vinculos WHERE discord_id = ?').all(discordId).map(r => r.zap_id);
}

// ---------- Futebol: tabela, rodada, time do coração, avisos ao vivo ----------
export function bolaoTabela() {
    return db('bolao')?.prepare('SELECT * FROM tabela ORDER BY posicao').all() ?? [];
}

export function bolaoRodada(numero = null) {
    const d = db('bolao');
    if (!d) return { rodada: null, jogos: [] };
    const t = d.prepare('SELECT MAX(temporada) AS t FROM jogos').get()?.t;
    const rodada = numero ?? d.prepare(`SELECT MIN(rodada) AS r FROM jogos WHERE temporada = ? AND rodada IS NOT NULL
        AND status NOT IN ('FINISHED','CANCELLED','AWARDED')`).get(t)?.r
        ?? d.prepare('SELECT MAX(rodada) AS r FROM jogos WHERE temporada = ?').get(t)?.r;
    const jogos = rodada == null ? [] : d.prepare('SELECT * FROM jogos WHERE temporada = ? AND rodada = ? ORDER BY data_utc, id').all(t, rodada);
    // Placar ao vivo da ESPN, quando houver (a football-data gratuita é atrasada)
    const vivos = d.prepare("SELECT * FROM ao_vivo WHERE atualizado > datetime('now', '-1 day')").all();
    return { rodada, jogos, vivos };
}

export function bolaoDefinirTime(discordId, time) {
    db('bolao').prepare(`INSERT INTO times_favoritos (discord_id, time_key, time_nome) VALUES (?, ?, ?)
        ON CONFLICT(discord_id) DO UPDATE SET time_key = excluded.time_key, time_nome = excluded.time_nome`)
        .run(discordId, time.key, time.nome);
}

export function bolaoRemoverTime(discordId) {
    return db('bolao').prepare('DELETE FROM times_favoritos WHERE discord_id = ?').run(discordId).changes > 0;
}

export function bolaoMeuTime(discordId) {
    return db('bolao')?.prepare('SELECT * FROM times_favoritos WHERE discord_id = ?').get(discordId) ?? null;
}

export function eventosPendentesZap() {
    // Só avisos recentes (se o Zap ficou fora do ar, não despeja gol velho no grupo)
    return db('bolao')?.prepare("SELECT * FROM eventos WHERE zap_ok = 0 AND criado > datetime('now', '-20 minutes') ORDER BY id").all() ?? [];
}

export function marcarZap(id) {
    db('bolao').prepare('UPDATE eventos SET zap_ok = 1 WHERE id = ?').run(id);
}

export function descartarEventosAntigosZap() {
    db('bolao')?.prepare("UPDATE eventos SET zap_ok = 1 WHERE zap_ok = 0 AND criado <= datetime('now', '-20 minutes')").run();
}

export function torcedoresDe(timesCsv) {
    const keys = timesCsv.split(',').filter(Boolean);
    if (!keys.length || !db('bolao')) return [];
    return db('bolao').prepare(`SELECT * FROM times_favoritos WHERE time_key IN (${keys.map(() => '?').join(',')})`).all(...keys);
}

// ---------- Retrospectiva semanal ----------
export function getEstado(chave) {
    return db('zap').prepare('SELECT valor FROM estado WHERE chave = ?').get(chave)?.valor ?? null;
}

export function setEstado(chave, valor) {
    db('zap').prepare('INSERT INTO estado (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor')
        .run(chave, String(valor));
}

// Contadores atuais: votos por filme/jogo e votos por pessoa
export function contadoresAtuais() {
    const c = new Map();
    for (const r of db('rmdb')?.prepare('SELECT movie_id AS id, vote_count AS n FROM avaliacoes_filmes').all() ?? []) c.set(`f:${r.id}`, r.n);
    for (const r of db('rgdb')?.prepare('SELECT game_id AS id, vote_count AS n FROM avaliacoes_jogos').all() ?? []) c.set(`j:${r.id}`, r.n);
    for (const r of db('rmdb')?.prepare('SELECT user_id AS id, COUNT(*) AS n FROM votos_filmes GROUP BY user_id').all() ?? []) c.set(`uf:${r.id}`, r.n);
    for (const r of db('rgdb')?.prepare('SELECT user_id AS id, COUNT(*) AS n FROM votos_jogos GROUP BY user_id').all() ?? []) c.set(`uj:${r.id}`, r.n);
    return c;
}

export function fotoAnterior() {
    return new Map(db('zap').prepare('SELECT chave, valor FROM retro_foto').all().map(r => [r.chave, r.valor]));
}

export function salvarFoto(contadores) {
    const d = db('zap');
    d.transaction(() => {
        d.prepare('DELETE FROM retro_foto').run();
        const ins = d.prepare('INSERT INTO retro_foto (chave, valor) VALUES (?, ?)');
        for (const [k, v] of contadores) ins.run(k, v);
    })();
}

export const infoFilme = id => db('rmdb')?.prepare('SELECT title, server_score, vote_count FROM avaliacoes_filmes WHERE movie_id = ?').get(id);
export const infoJogo = id => db('rgdb')?.prepare('SELECT title, server_score, vote_count FROM avaliacoes_jogos WHERE game_id = ?').get(id);
export const nomeUsuario = id =>
    db('rmdb')?.prepare('SELECT username FROM votos_filmes WHERE user_id = ? AND username IS NOT NULL LIMIT 1').get(id)?.username ??
    db('rgdb')?.prepare('SELECT username FROM votos_jogos WHERE user_id = ? AND username IS NOT NULL LIMIT 1').get(id)?.username ?? 'alguém';

// Pontos do bolão em jogos dos últimos 7 dias
export function bolaoSemana() {
    const d = db('bolao');
    if (!d) return [];
    const desde = new Date(Date.now() - 7 * 86_400_000).toISOString();
    return d.prepare(`
        SELECT MAX(p.username) AS nome, SUM(p.pontos) AS pontos, SUM(CASE WHEN p.pontos = 25 THEN 1 ELSE 0 END) AS exatos
        FROM palpites p JOIN jogos j ON j.id = p.jogo_id
        WHERE j.status = 'FINISHED' AND j.data_utc >= ? AND p.pontos IS NOT NULL
        GROUP BY p.user_id ORDER BY pontos DESC, exatos DESC LIMIT 5`).all(desde);
}

// Aniversários dos próximos 7 dias (DD-MM)
export function aniversariosProximos() {
    const d = db('aniv');
    if (!d) return [];
    const dias = [];
    for (let i = 1; i <= 7; i++) {
        const x = new Date(Date.now() + i * 86_400_000);
        dias.push(`${String(x.getDate()).padStart(2, '0')}-${String(x.getMonth() + 1).padStart(2, '0')}`);
    }
    return d.prepare(`SELECT name, birthday FROM birthdays WHERE birthday IN (${dias.map(() => '?').join(',')})`).all(...dias)
        .sort((a, b) => dias.indexOf(a.birthday) - dias.indexOf(b.birthday));
}

// ---------- Lembretes ----------
export function criarLembrete(chat, autor, texto, quando) {
    return db('zap').prepare('INSERT INTO lembretes (chat, autor, texto, quando) VALUES (?, ?, ?, ?)').run(chat, autor, texto, quando).lastInsertRowid;
}

export function lembretesPendentes(autor) {
    return db('zap').prepare('SELECT * FROM lembretes WHERE autor = ? AND enviado = 0 ORDER BY quando').all(autor);
}

export function cancelarLembrete(id, autor) {
    return db('zap').prepare('DELETE FROM lembretes WHERE id = ? AND autor = ? AND enviado = 0').run(id, autor).changes > 0;
}

export function lembretesVencidos() {
    return db('zap').prepare('SELECT * FROM lembretes WHERE enviado = 0 AND quando <= ? ORDER BY quando').all(Date.now());
}

export function marcarLembrete(id) {
    db('zap').prepare('UPDATE lembretes SET enviado = 1 WHERE id = ?').run(id);
    db('zap').prepare("DELETE FROM lembretes WHERE enviado = 1 AND quando < ?").run(Date.now() - 7 * 86_400_000);
}

// Quem escolheu time do coração (!torcidas), com o nome do vínculo quando houver
export function torcidas() {
    const nomes = new Map(db('zap').prepare('SELECT discord_id, nome FROM vinculos').all().map(r => [r.discord_id, r.nome]));
    return (db('bolao')?.prepare('SELECT discord_id, time_nome FROM times_favoritos ORDER BY time_nome').all() ?? [])
        .map(r => ({ ...r, nome: nomes.get(r.discord_id) ?? null }));
}

