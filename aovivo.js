// Posta no grupo os avisos de gol e fim de jogo gerados pelo bot do bolão,
// marcando quem torce para os times do jogo e vinculou o Zap. Gol vai com animação (golgif.js).
import * as b from './bancos.js';
import config from './config.js';
import { gifDoGol } from './golgif.js';

export async function postarEventos(sock) {
    if (!config.grupoId) return;
    b.descartarEventosAntigosZap();
    for (const ev of b.eventosPendentesZap()) {
        const mencoes = [];
        for (const t of b.torcedoresDe(ev.times)) {
            const ids = b.zapIdsDe(t.discord_id);
            const jid = ids.find(i => i.endsWith('@s.whatsapp.net')) || ids[0];
            if (jid) mencoes.push(jid);
        }
        const texto = ev.texto + (mencoes.length ? `\n${mencoes.map(j => `@${j.split('@')[0]}`).join(' ')}` : '');
        // Gol vai com a animação (GIF); se ela falhar, vai só o texto
        let gif = null;
        try { gif = await gifDoGol(ev.texto); } catch (e) { console.error('Animação do gol:', e.message); }
        try {
            await sock.sendMessage(config.grupoId, gif
                ? { video: gif, gifPlayback: true, caption: texto, mentions: mencoes }
                : { text: texto, mentions: mencoes });
            b.marcarZap(ev.id);
        } catch (e) {
            console.error('Falha ao postar aviso de jogo:', e.message);
            return; // tenta de novo na próxima volta
        }
    }
}
