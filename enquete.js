// !enquete: cria uma enquete nativa do WhatsApp (votos e contagem ficam com o próprio WhatsApp).
//   !enquete Pizza hoje? | Sim | Não | Só se for de calabresa
//   !enquete+ ...  → permite votar em mais de uma opção
export const COMANDOS_ENQUETE = ['enquete', 'enquete+', 'votacao', 'votação'];

export function lerEnquete(texto) {
    const t = texto.trim();
    const cmd = t.split(/\s+/)[0];
    const partes = t.slice(cmd.length).split(/[\n|]+/).map(s => s.trim()).filter(Boolean);   // mantém as quebras de linha
    const [pergunta, ...opcoes] = partes;
    const unicas = [...new Set(opcoes.map(o => o.slice(0, 100)))];
    return { pergunta: pergunta?.slice(0, 255), opcoes: unicas, multipla: cmd.endsWith('+') };
}

export async function tratarEnquete(sock, msg, texto) {
    const { pergunta, opcoes, multipla } = lerEnquete(texto);
    if (!pergunta || opcoes.length < 2 || opcoes.length > 12) {
        return sock.sendMessage(msg.key.remoteJid, {
            text: '🗳️ *Enquete*: pergunta e de 2 a 12 opções separadas por | (ou uma por linha)\n' +
                '*!enquete Pizza hoje? | Sim | Não | Só se for de calabresa*\n' +
                'Use *!enquete+* pra deixar votar em mais de uma opção.'
        }, { quoted: msg });
    }
    return sock.sendMessage(msg.key.remoteJid, {
        poll: { name: pergunta, values: opcoes, selectableCount: multipla ? opcoes.length : 1 }
    });
}
