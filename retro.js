// Retrospectiva semanal no grupo: domingo à noite, o que rolou na semana nos bots.
import * as b from './bancos.js';
import config from './config.js';

const DIA = Number(process.env.RETRO_DIA ?? 0);     // 0 = domingo
const HORA = Number(process.env.RETRO_HORA ?? 20);  // horário de Brasília
const fmt = n => Number(n).toFixed(1);
const medalha = i => ['🥇', '🥈', '🥉'][i] ?? `${i + 1}.`;

// Diferença dos contadores desde a última retrospectiva
function novidades(atual, antes, prefixo) {
    return [...atual].filter(([k]) => k.startsWith(prefixo))
        .map(([k, v]) => ({ id: k.slice(prefixo.length), novos: v - (antes.get(k) ?? 0) }))
        .filter(x => x.novos > 0)
        .sort((a, c) => c.novos - a.novos);
}

function montarRetro() {
    const atual = b.contadoresAtuais();
    const antes = b.fotoAnterior();
    const partes = ['📰 *Retrospectiva da semana no Regresso*'];

    const filmes = novidades(atual, antes, 'f:').map(x => ({ ...x, ...b.infoFilme(x.id) })).filter(x => x.title);
    if (filmes.length) {
        const melhor = [...filmes].sort((a, c) => c.server_score - a.server_score)[0];
        partes.push(`🎬 *Filmes e séries:* ${filmes.length} avaliado(s) — destaque: *${melhor.title}* (⭐ ${fmt(melhor.server_score)})\n` +
            filmes.slice(0, 5).map(f => `• ${f.title} — ⭐ ${fmt(f.server_score)} (+${f.novos} voto${f.novos > 1 ? 's' : ''})`).join('\n'));
    }

    const jogos = novidades(atual, antes, 'j:').map(x => ({ ...x, ...b.infoJogo(x.id) })).filter(x => x.title);
    if (jogos.length) {
        partes.push(`🎮 *Games:* ${jogos.length} avaliado(s)\n` +
            jogos.slice(0, 5).map(g => `• ${g.title} — ⭐ ${fmt(g.server_score)} (+${g.novos})`).join('\n'));
    }

    // Quem mais avaliou (filmes + jogos)
    const porPessoa = new Map();
    for (const x of [...novidades(atual, antes, 'uf:'), ...novidades(atual, antes, 'uj:')]) {
        porPessoa.set(x.id, (porPessoa.get(x.id) ?? 0) + x.novos);
    }
    const criticos = [...porPessoa].sort((a, c) => c[1] - a[1]).slice(0, 3);
    if (criticos.length) {
        partes.push('🏅 *Quem mais avaliou:* ' + criticos.map(([id, n], i) => `${medalha(i)} ${b.nomeUsuario(id)} (${n})`).join('  '));
    }

    const bolao = b.bolaoSemana();
    if (bolao.length) {
        partes.push('⚽ *Bolão na semana:*\n' + bolao.map((r, i) => `${medalha(i)} ${r.nome} — ${r.pontos} pts${r.exatos ? ` (${r.exatos} na mosca)` : ''}`).join('\n'));
    }

    const aniv = b.aniversariosProximos();
    if (aniv.length) {
        partes.push('🎂 *Aniversários da semana que vem:* ' + aniv.map(a => `${a.name} (${a.birthday.replace('-', '/')})`).join(', '));
    }

    if (partes.length === 1) partes.push('Semana parada por aqui... bora avaliar uns filmes e jogos! 😴');
    return { texto: partes.join('\n\n'), atual };
}

// Chamada de tempos em tempos; envia uma vez por semana no dia/hora configurados.
export async function verificarRetro(sock) {
    if (!config.grupoId) return;
    // Primeira vez: só tira a "foto" para a semana seguinte ter com o que comparar.
    if (!b.getEstado('retro_inicio')) {
        b.salvarFoto(b.contadoresAtuais());
        b.setEstado('retro_inicio', new Date().toISOString());
        return;
    }
    const agora = new Date();
    if (agora.getDay() !== DIA || agora.getHours() < HORA) return;
    const chave = `retro_${agora.getFullYear()}-${agora.getMonth() + 1}-${agora.getDate()}`;
    if (b.getEstado(chave)) return;
    const { texto, atual } = montarRetro();
    await sock.sendMessage(config.grupoId, { text: texto });
    b.salvarFoto(atual);
    b.setEstado(chave, agora.toISOString());
    console.log('📰 Retrospectiva semanal postada.');
}
