// Posta no grupo os avisos de gol e fim de jogo gerados pelo bot do bolão,
// marcando quem torce para os times do jogo e vinculou o Zap.
import * as b from './bancos.js';
import config from './config.js';

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
        try {
            await sock.sendMessage(config.grupoId, { text: texto, mentions: mencoes });
            b.marcarZap(ev.id);
        } catch (e) {
            console.error('Falha ao postar aviso de jogo:', e.message);
            return; // tenta de novo na próxima volta
        }
    }
}
