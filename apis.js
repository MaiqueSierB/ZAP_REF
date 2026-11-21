// Buscas no TMDB (filmes/séries) e na RAWG (jogos), com os mesmos filtros dos bots do Discord.
import config from './config.js';

export async function buscarFilmes(nome) {
    if (!config.tmdbKey) throw new Error('chave do TMDB não encontrada');
    const url = `https://api.themoviedb.org/3/search/multi?api_key=${config.tmdbKey}` +
        `&query=${encodeURIComponent(nome)}&language=pt-BR`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`TMDB respondeu ${res.status}`);
    const data = await res.json();
    return (data.results || [])
        .filter(r => (r.media_type === 'movie' || r.media_type === 'tv') && r.vote_count > 50 && r.poster_path)
        .sort((a, b) => b.popularity - a.popularity)
        .slice(0, 5)
        .map(r => ({
            id: r.id,
            titulo: r.title || r.name,
            ano: (r.release_date || r.first_air_date || '').slice(0, 4),
            tipo: r.media_type === 'tv' ? 'série' : 'filme'
        }));
}

export async function buscarJogos(nome) {
    if (!config.rawgKey) throw new Error('chave da RAWG não encontrada');
    const url = `https://api.rawg.io/api/games?key=${config.rawgKey}&search=${encodeURIComponent(nome)}&page_size=5`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`RAWG respondeu ${res.status}`);
    const data = await res.json();
    return (data.results || []).slice(0, 5).map(g => ({
        id: g.id,
        titulo: g.name,
        ano: (g.released || '').slice(0, 4)
    }));
}
