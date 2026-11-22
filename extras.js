// Comandos que o Discord já tinha e o Zap não:
//   !assistir <filme>  → põe na sua lista "quero ver" (a mesma do /assistir do RMDB; o aviso de streaming chega no privado do Discord)
//   !lista             → sua lista  ·  !tirar <filme> → tira da lista
//   !onde <filme>      → em qual streaming está (Brasil)
//   !recomenda <filme> → filmes parecidos
//   !perfil            → seu resumo: notas, XP dos games, bolão, time, aniversário
//   !niver DD/MM       → cadastra seu aniversário (o mesmo do bot de aniversários)
import config from './config.js';
import { banco } from './bancos.js';

async function tmdb(caminho) {
    if (!config.tmdbKey) throw new Error('chave do TMDB não encontrada');
    const sep = caminho.includes('?') ? '&' : '?';
    const r = await fetch(`https://api.themoviedb.org/3${caminho}${sep}api_key=${config.tmdbKey}&language=pt-BR`, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`TMDB respondeu ${r.status}`);
    return r.json();
}

const ano = d => (d || '').slice(0, 4) || '?';

// ---------- Lista "quero ver" (tabelas do RMDB) ----------
function rmdb() {
    const d = banco('rmdb');
    if (!d) throw new Error('banco do RMDB não encontrado');
    d.exec(`CREATE TABLE IF NOT EXISTS watchlist (discord_id TEXT NOT NULL, tmdb_id INTEGER NOT NULL, titulo TEXT NOT NULL, criado_em INTEGER NOT NULL, PRIMARY KEY (discord_id, tmdb_id));
            CREATE TABLE IF NOT EXISTS streaming_cache (tmdb_id INTEGER PRIMARY KEY, provedores TEXT NOT NULL, checado_em INTEGER NOT NULL);`);
    return d;
}

async function provedores(tipo, id) {
    const br = (await tmdb(`/${tipo}/${id}/watch/providers`)).results?.BR ?? {};
    return {
        assinatura: (br.flatrate ?? []).map(p => p.provider_name),
        aluguel: [...new Set([...(br.rent ?? []), ...(br.buy ?? [])].map(p => p.provider_name))]
    };
}

export async function assistir(discordId, busca) {
    if (!busca) return 'Use: !assistir <nome do filme>';
    const f = (await tmdb(`/search/movie?query=${encodeURIComponent(busca)}`)).results?.[0];
    if (!f) return `Não achei "${busca}" 🤔`;
    const d = rmdb();
    d.prepare('INSERT OR IGNORE INTO watchlist VALUES (?, ?, ?, ?)').run(discordId, f.id, f.title, Date.now());
    const { assinatura } = await provedores('movie', f.id);
    d.prepare('INSERT OR REPLACE INTO streaming_cache VALUES (?, ?, ?)').run(f.id, JSON.stringify(assinatura), Date.now());
    return `📌 *${f.title}* (${ano(f.release_date)}) na sua lista.\n` +
        (assinatura.length ? `Já está em: ${assinatura.join(', ')} 🍿` : 'Ainda não está em streaming. Quando chegar, o bot do Discord te avisa no privado 👀');
}

export function lista(discordId) {
    const itens = rmdb().prepare(`
        SELECT w.titulo, c.provedores FROM watchlist w LEFT JOIN streaming_cache c ON c.tmdb_id = w.tmdb_id
        WHERE w.discord_id = ? ORDER BY w.criado_em`).all(discordId);
    if (!itens.length) return 'Sua lista está vazia. Use *!assistir <nome do filme>*';
    return '🎬 *Sua lista "quero ver"*\n' + itens.map(r => {
        const p = JSON.parse(r.provedores ?? '[]');
        return `• ${r.titulo} — ${p.length ? p.join(', ') : 'ainda não está em streaming'}`;
    }).join('\n').slice(0, 3500);
}

export function tirar(discordId, busca) {
    if (!busca) return 'Use: !tirar <nome do filme>';
    const d = rmdb();
    const f = d.prepare(`SELECT tmdb_id, titulo FROM watchlist WHERE discord_id = ? AND titulo LIKE ?
        ORDER BY (lower(titulo) = lower(?)) DESC, length(titulo) LIMIT 1`).get(discordId, `%${busca}%`, busca);
    if (!f) return 'Esse filme não está na sua lista.';
    d.prepare('DELETE FROM watchlist WHERE discord_id = ? AND tmdb_id = ?').run(discordId, f.tmdb_id);
    return `🗑️ *${f.titulo}* saiu da sua lista.`;
}

// ---------- Onde assistir / recomendações ----------
export async function onde(busca) {
    if (!busca) return 'Use: !onde <nome do filme ou série>';
    const r = ((await tmdb(`/search/multi?query=${encodeURIComponent(busca)}`)).results ?? [])
        .find(x => x.media_type === 'movie' || x.media_type === 'tv');
    if (!r) return `Não achei "${busca}" 🤔`;
    const { assinatura, aluguel } = await provedores(r.media_type, r.id);
    const titulo = `*${r.title || r.name}* (${ano(r.release_date || r.first_air_date)})`;
    if (!assinatura.length && !aluguel.length) return `📺 ${titulo}: não está em nenhum streaming no Brasil agora.`;
    return `📺 ${titulo}\n` +
        (assinatura.length ? `Assinatura: ${assinatura.join(', ')}\n` : '') +
        (aluguel.length ? `Alugar/comprar: ${aluguel.slice(0, 6).join(', ')}` : '');
}

export async function recomenda(busca) {
    if (!busca) return 'Use: !recomenda <um filme que você curtiu>';
    const f = (await tmdb(`/search/movie?query=${encodeURIComponent(busca)}`)).results?.[0];
    if (!f) return `Não achei "${busca}" 🤔`;
    const recs = ((await tmdb(`/movie/${f.id}/recommendations`)).results ?? []).slice(0, 8);
    if (!recs.length) return `Não achei recomendações a partir de *${f.title}*.`;
    return `🎯 *Quem curtiu ${f.title} pode gostar de:*\n` + recs.map(x => `• ${x.title} (${ano(x.release_date)})`).join('\n');
}

// ---------- Perfil ----------
export function perfil(quem) {
    const id = quem.discord_id;
    const linhas = [`👤 *${quem.nome}*`];
    const f = banco('rmdb')?.prepare('SELECT COUNT(*) AS n, AVG(score) AS m FROM votos_filmes WHERE user_id = ?').get(id);
    if (f?.n) linhas.push(`🎬 ${f.n} filmes/séries avaliados · média ${f.m.toFixed(1)}`);
    const j = banco('rgdb')?.prepare('SELECT COUNT(*) AS n, AVG(score) AS m FROM votos_jogos WHERE user_id = ?').get(id);
    if (j?.n) linhas.push(`🎮 ${j.n} jogos avaliados · média ${j.m.toFixed(1)}`);
    const xp = banco('rgdb')?.prepare('SELECT xp, level FROM usuarios WHERE user_id = ?').get(id);
    if (xp) linhas.push(`⚡ Nível ${xp.level} nos games (${xp.xp} XP)`);
    const b = banco('bolao');
    const temporada = b?.prepare('SELECT MAX(temporada) AS t FROM jogos').get()?.t;
    if (temporada != null) {
        const ranking = b.prepare(`SELECT p.user_id, COALESCE(SUM(p.pontos), 0) AS pontos, SUM(CASE WHEN p.pontos = 25 THEN 1 ELSE 0 END) AS exatos
            FROM palpites p JOIN jogos j ON j.id = p.jogo_id WHERE j.temporada = ? GROUP BY p.user_id ORDER BY pontos DESC, exatos DESC`).all(temporada);
        const pos = ranking.findIndex(r => r.user_id === id);
        if (pos >= 0) linhas.push(`⚽ Bolão ${temporada}: ${ranking[pos].pontos} pts · ${pos + 1}º lugar · ${ranking[pos].exatos} na mosca`);
    }
    const time = b?.prepare('SELECT time_nome FROM times_favoritos WHERE discord_id = ?').get(id)?.time_nome;
    if (time) linhas.push(`❤️ Time: ${time}`);
    const aniv = banco('aniv')?.prepare('SELECT birthday FROM birthdays WHERE user_id = ?').get(id)?.birthday;
    linhas.push(aniv ? `🎂 Aniversário: ${aniv.replace('-', '/')}` : '🎂 Aniversário não cadastrado (use *!niver DD/MM*)');
    const quer = banco('rmdb')?.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'watchlist'").get()?.n
        ? banco('rmdb').prepare('SELECT COUNT(*) AS n FROM watchlist WHERE discord_id = ?').get(id).n : 0;
    if (quer) linhas.push(`📌 ${quer} filme(s) na lista "quero ver"`);
    return linhas.join('\n');
}

// ---------- Aniversário ----------
export function niver(quem, arg) {
    const m = String(arg).match(/^(\d{1,2})\s*[/-]\s*(\d{1,2})$/);
    if (!m) return 'Use: !niver DD/MM (ex.: !niver 05/09)';
    const dia = Number(m[1]), mes = Number(m[2]);
    const valido = new Date(2024, mes - 1, dia);   // 2024 é bissexto: aceita 29/02
    if (mes < 1 || mes > 12 || valido.getDate() !== dia) return 'Essa data não existe 🤨';
    const d = banco('aniv');
    if (!d) return 'Não achei o banco do bot de aniversários.';
    const data = `${String(dia).padStart(2, '0')}-${String(mes).padStart(2, '0')}`;
    d.prepare(`INSERT INTO birthdays (name, user_id, birthday) VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET birthday = excluded.birthday`).run(quem.nome, quem.discord_id, data);
    return `🎂 Anotado: *${data.replace('-', '/')}*. No dia o grupo fica sabendo!`;
}
