// Garante que só UM processo use a sessão do WhatsApp por vez.
// Em deploys/reinícios a Hostinger pode deixar o processo antigo vivo por alguns segundos;
// se os dois conectarem com a mesma sessão, o WhatsApp derruba (logout).
import fs from 'node:fs';
import path from 'node:path';

const VALIDADE = 30_000; // trava "velha" (sem batimento) depois de 30s
let timer = null;

function ler(arquivo) {
    try { return JSON.parse(fs.readFileSync(arquivo, 'utf8')); } catch { return null; }
}

export async function pegarTrava(arquivo) {
    fs.mkdirSync(path.dirname(arquivo), { recursive: true });
    for (;;) {
        const t = ler(arquivo);
        // Só vale o batimento: na Hostinger os processos podem estar em "caixas" separadas,
        // então checar o pid do outro processo não é confiável (parecia morto e a sessão era roubada).
        const livre = !t || t.pid === process.pid || Date.now() - t.ts > VALIDADE;
        if (livre) {
            fs.writeFileSync(arquivo, JSON.stringify({ pid: process.pid, ts: Date.now() }));
            await new Promise(r => setTimeout(r, 500));
            if (ler(arquivo)?.pid === process.pid) break; // ganhou a disputa
        } else {
            console.log(`Outro processo (pid ${t.pid}) está com a sessão do WhatsApp. Aguardando...`);
            await new Promise(r => setTimeout(r, 10_000));
        }
    }
    timer = setInterval(() => {
        const t = ler(arquivo);
        if (t && t.pid !== process.pid) {
            console.error('Outro processo assumiu a sessão. Encerrando este para não derrubar o WhatsApp.');
            process.exit(0);
        }
        fs.writeFileSync(arquivo, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    }, 10_000);
    const soltar = () => {
        clearInterval(timer);
        if (ler(arquivo)?.pid === process.pid) fs.rmSync(arquivo, { force: true });
        process.exit(0);
    };
    process.once('SIGTERM', soltar);
    process.once('SIGINT', soltar);
}
