import fs from 'node:fs';
import dotenv from 'dotenv';

dotenv.config();

// Datas (aniversários, bolão) no horário de Brasília
process.env.TZ = process.env.TZ || 'America/Sao_Paulo';

// Pasta dos bots na Hostinger (fora da public_html, não some nos deploys)
const BASE = process.env.BOTS_DIR || '/home/u243267678/domains/mrbnexus.com.br';

// Lê um .env de outro bot só para reaproveitar uma chave de API (sem misturar o TOKEN).
function lerChave(arquivo, chave) {
    try {
        return fs.existsSync(arquivo) ? dotenv.parse(fs.readFileSync(arquivo))[chave] : undefined;
    } catch {
        return undefined;
    }
}

const rmdbEnv = process.env.RMDB_ENV || `${BASE}/.rmdb.env`;
const rgdbEnv = process.env.RGDB_ENV || `${BASE}/.rgdb.env`;

const config = {
    // número do bot no formato internacional, só dígitos (ex.: 5564999999999)
    numero: (process.env.ZAP_NUMERO || '').replace(/\D/g, ''),
    // se definido, o bot só responde nesse grupo (descubra com !id)
    grupoId: process.env.ZAP_GROUP_ID || '',
    prefixo: process.env.ZAP_PREFIXO || '!',

    authDir: process.env.ZAP_AUTH_DIR || `${BASE}/zap-data/auth`,
    zapDb: process.env.ZAP_DB || `${BASE}/zap-data/zap.sqlite`,
    rmdbDb: process.env.RMDB_DB || `${BASE}/rmdb-data/servidor.sqlite`,
    rgdbDb: process.env.RGDB_DB || `${BASE}/rgdb-data/servidor.sqlite`,
    bolaoDb: process.env.BOLAO_DB || `${BASE}/bolao-data/bolao.sqlite`,
    anivDb: process.env.ANIV_DB || `${BASE}/aniversario-data/servidor.sqlite`,
    // hora (Brasília) a partir da qual o parabéns é postado no grupo
    anivHora: Number(process.env.ANIV_HORA ?? 9),

    antijanjaUrl: process.env.ANTIJANJA_URL || 'https://antijanja.mrbnexus.com.br',
    antijanjaKeyFile: process.env.ANTIJANJA_KEY_FILE || `${BASE}/zap-data/antijanja.key`,

    tmdbKey: process.env.TMDB_API_KEY || lerChave(rmdbEnv, 'TMDB_API_KEY'),
    rawgKey: process.env.RAWG_API_KEY || lerChave(rgdbEnv, 'RAWG_API_KEY')
};

console.log(`Config: numero=${config.numero ? 'ok' : 'faltando'} grupo=${config.grupoId || '(qualquer)'} ` +
    `tmdb=${config.tmdbKey ? 'ok' : 'faltando'} rawg=${config.rawgKey ? 'ok' : 'faltando'}`);

export default config;
