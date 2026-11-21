// Posta o parabéns no grupo do WhatsApp, lendo o banco do bot de aniversários do Discord.
import * as b from './bancos.js';
import config from './config.js';

const MENSAGENS = [
    '🎉 Pessoal, hoje é aniversário de {user}! Bora mandar os parabéns! 🥳🎂',
    'Atenção, galera! Hoje o parabéns vai pro(a) maior resenhudo(a) do Regresso: {user}! 🎈',
    'Opa, {user} subiu de nível hoje! Parabéns por mais uma volta ao sol! 🎂',
    'Por decreto deste grupo, hoje é o dia oficial de parabenizar {user}! Felicidades! 🥳',
    'Nem é meme: hoje é mesmo aniversário de {user}! Manda os parabéns aí, rapaziada! 🎉'
];

const dois = n => String(n).padStart(2, '0');

export async function verificarAniversarios(sock) {
    if (!config.grupoId) return;                       // sem grupo travado, não posta em lugar nenhum
    const agora = new Date();
    if (agora.getHours() < config.anivHora) return;    // não acorda ninguém de madrugada
    const ddmm = `${dois(agora.getDate())}-${dois(agora.getMonth() + 1)}`;
    const dataISO = `${agora.getFullYear()}-${dois(agora.getMonth() + 1)}-${dois(agora.getDate())}`;

    for (const a of b.aniversariantesDoDia(ddmm, dataISO)) {
        // Se a pessoa vinculou o Zap, marca ela; senão usa o nome cadastrado.
        const ids = b.zapIdsDe(a.user_id);
        const jid = ids.find(i => i.endsWith('@s.whatsapp.net')) || ids[0];
        const nome = jid ? `@${jid.split('@')[0]}` : `*${a.name}*`;
        const texto = MENSAGENS[Math.floor(Math.random() * MENSAGENS.length)].replace('{user}', nome);
        const mentions = jid ? [jid] : [];
        try {
            if (a.image_url) {
                await sock.sendMessage(config.grupoId, { image: { url: a.image_url }, caption: texto, mentions })
                    .catch(() => sock.sendMessage(config.grupoId, { text: texto, mentions }));
            } else {
                await sock.sendMessage(config.grupoId, { text: texto, mentions });
            }
            b.marcarAnivEnviado(a.user_id, dataISO);
            console.log(`🎂 Parabéns de ${a.name} postado no grupo.`);
        } catch (e) {
            console.error(`Falha ao postar aniversário de ${a.name}:`, e.message);
        }
    }
}
