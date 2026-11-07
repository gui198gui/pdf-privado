# PDF Privado 🔒

**Ferramentas de PDF que não saem do teu computador.**

🔗 **https://gui198gui.github.io/pdf-privado/**

A maioria dos sites para juntar ou comprimir PDFs obriga-te a enviar os teus documentos para um servidor:
contratos, faturas, documentos de identificação… O **PDF Privado** faz tudo **dentro do browser**.
Os ficheiros são lidos e processados no teu dispositivo e **nunca são enviados para lado nenhum**.

## Ferramentas

| | Ferramenta | O que faz |
|---|---|---|
| ➕ | **Juntar PDFs** | Combina vários PDFs num só; reordena arrastando |
| 🗂️ | **Organizar páginas** | Reordena, roda e apaga páginas, com pré-visualização |
| ✂️ | **Separar PDF** | Extrai intervalos (`1-3, 5, 8-10`), um PDF por intervalo ou uma página por ficheiro (ZIP) |
| 🖼️ | **Imagens para PDF** | JPG, PNG e WebP para PDF (A4, Carta ou tamanho da imagem), respeitando a orientação das fotos de telemóvel |
| 📸 | **PDF para imagens** | Exporta páginas em JPG ou PNG a 96, 150 ou 300 DPI |
| 🗜️ | **Comprimir PDF** | Reduz PDFs digitalizados (ex: 8,2 MB → 658 KB), com opção de preto e branco |

## Características

- **Privado:** sem servidor e sem uploads; tudo corre em JavaScript no browser
- **Offline:** é uma PWA com *service worker*; depois da primeira visita funciona sem internet e pode ser instalada como app no computador ou no telemóvel
- **Sem dependências externas em tempo de execução:** as bibliotecas estão incluídas no repositório (pasta `vendor/`)
- **Grátis:** sem contas, sem limites e sem marcas de água
- **Tema claro e escuro** automático, e interface adaptada a telemóvel

## Tecnologias

- HTML, CSS e JavaScript (ES modules), sem frameworks
- [pdf-lib](https://pdf-lib.js.org): criar e editar PDFs (juntar, copiar e rodar páginas, inserir imagens)
- [PDF.js](https://mozilla.github.io/pdf.js/) (Mozilla): desenhar as páginas em `canvas` para miniaturas, exportação e compressão
- [JSZip](https://stuk.github.io/jszip/): criar ficheiros ZIP com vários resultados
- Service Worker + Web App Manifest (PWA)

## Como funciona a compressão

Cada página é desenhada num `canvas` com o PDF.js a uma resolução mais baixa (96–170 DPI),
convertida em JPEG com a qualidade escolhida e inserida num PDF novo com o tamanho de página original.
Funciona muito bem para digitalizações e PDFs com fotografias. Como as páginas passam a ser imagens,
o texto deixa de poder ser selecionado. Por isso a app avisa quando o resultado não compensa.

## Correr localmente

Os *ES modules* e o *service worker* precisam de um servidor HTTP (não funcionam abrindo o `index.html` diretamente):

```bash
python -m http.server 8000
# abrir http://localhost:8000
```

## Estrutura

```
pdf-privado/
├── index.html            ← interface (6 ferramentas)
├── css/app.css
├── js/app.js             ← lógica de todas as ferramentas
├── sw.js                 ← service worker (offline)
├── manifest.webmanifest  ← dados da app instalável
├── icons/
└── vendor/               ← pdf-lib, PDF.js, JSZip (+ licenças)
```

## Licença

Código da app sob licença MIT. As bibliotecas em `vendor/` mantêm as suas licenças
(pdf-lib: MIT · PDF.js: Apache 2.0 · JSZip: MIT/GPLv3).

## Autor

**Guilherme Martins**, estudante de Engenharia Informática no IPCB.
[Portefólio](https://gui198gui.github.io) · [LinkedIn](https://www.linkedin.com/in/guilherme-martins-158279309/) · [GitHub](https://github.com/gui198gui)
