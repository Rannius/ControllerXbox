# Saját GitHub Actions runner

A repó összes jelenlegi Actions-jobja ezt a rögzített saját runnerkészletet használja:

`[self-hosted, Linux, X64, rannius-linux, project-controllerxbox]`

Offline vagy hiányzó runner mellett a job vár; nincs GitHub-hosted visszaesés.
A `runner-check.yml` kézzel indítható, és ellenőrzi a futtató gépet, az eszközöket és a workflow-k fix runnerkiválasztását.
Új job ugyanazt az inline `runs-on` listát használja. Változóval, mátrixszal vagy külső újrahasználható workflow-val új runnerkiválasztást csak külön felülvizsgálattal vezess be.
Az ellenőrzés a jelenlegi workflow-kra vonatkozik; a személyes fiókban nem helyettesít szervezeti hosted-runner tiltást. Régi commit vagy tag workflow-jának újrafuttatása az abban rögzített korábbi környezetet használhatja.

Saját runneren a GitHub-hosted számítási percek nem fogynak. GitHub artifact és cache tárhely külön kvóta; a repó ebben a változásban nem kap új felhős artifactot vagy cache-t.

## Linux buildgép

A SteamOS helper statikus Linux/musl ELF program. A kiadás Ubuntu x64 buildgépet igényel; Windows runner címkéinek átnevezése nem pótolja ezt.
Szükséges: Git, Bash, GitHub CLI (`gh`), Python 3, Rustup/Cargo és jelszó nélküli `sudo apt-get` a rögzített Rust 1.90.0 és musl-tools előkészítéséhez. A Node.js 22 és pnpm 11.9.0 verziókat továbbra is a workflow telepíti.
A runner egyedileg ebbe a repóba legyen regisztrálva, a fenti címkékkel. A workflow csak megbízható `v*` tag esetén publikál; nyilvános fork pull requestje nem indít saját gépen jobot.
A kész Linux ZIP és árszervercsomag sorrendje, tartalma és ellenőrzése változatlan.
