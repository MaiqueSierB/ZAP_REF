# Bot de WhatsApp do Regresso

Conecta um número de WhatsApp (via [Baileys](https://baileys.wiki), não oficial) ao grupo do Regresso e grava direto nos bancos dos bots do Discord:

- **RMDB** — `!filme nome`, `!nota 1 8.5`, `!top filmes`
- **RGDB** — `!game nome`, `!nota 1 9 zerei`, `!top games`
- **Bolão** — `!bolao`, `!palpite 1 2x1`, `!meuspalpites`, `!ranking`
- **Vínculo** — `/zap` no Discord gera um código; `!vincular CÓDIGO` no grupo liga o número ao perfil do Discord

`!ajuda` lista tudo. Comandos desconhecidos são ignorados para não poluir o grupo.

## Configuração (variáveis de ambiente)

| Variável | Para quê |
|---|---|
| `ZAP_NUMERO` | Número do bot, só dígitos com DDI (ex.: 5564999999999) — usado no pareamento |
| `ZAP_GROUP_ID` | Opcional: trava o bot num grupo (descubra com `!id`) |
| `BOTS_DIR` | Pasta onde ficam os bancos e `.env` dos outros bots |
| `ZAP_AUTH_DIR`, `ZAP_DB`, `RMDB_DB`, `RGDB_DB`, `BOLAO_DB` | Caminhos (padrão dentro de `BOTS_DIR`) |

As chaves do TMDB e da RAWG são lidas dos `.env` do RMDB e do RGDB.

## Primeiro acesso

Sem sessão salva, o bot escreve no log um **código de pareamento**. No celular do número do bot: WhatsApp → Aparelhos conectados → Conectar aparelho → *Conectar com número de telefone* → digite o código.

⚠️ Baileys não é oficial: o WhatsApp pode banir o número. Use um número dedicado.
