# ReelHeist — Tasarım

## Amaç

Kullanıcı, tarayıcıda izlediği video içeriğini bilgisayara indirip sonra izlemek ister.
Eklenti bu işi tek tıkla yapar: video MP4 olarak, altyazılar yanında SRT olarak, bütün ses
seçenekleri aynı MP4 içinde.

## Hedefler

- Tek bölüm/film indirme, kalite seçimi.
- Bütün ses kanallarını aynı MP4 dosyasına koyma (kullanıcı oynatıcıda seçer).
- Bütün altyazıları videonun yanına, aynı adla, SRT olarak kaydetme.
- Klasör adı dizi/film adı.
- Bir sezonu tek seferde kuyruğa ekleme.
- İndirme kuyruğu: ilerleme, boyut, kalan süre, iptal, yeniden dene, klasörü aç.
- YouTube için `yt-dlp` ile indirme.
- Sayfa inceleme yönlendirmesi yapan DevTools algılayıcılarını etkisiz bırakma (siteye özel
  kurallar site paketlerinde durur; ana kodda yoktur).

## Hedef dışı

- DRM'li içerik (Widevine vb.). DRM olan yerde eklenti "desteklenmiyor" der.
- Siteye özel şifre çözme kodu. Genel yöntem kullanılır.
- Altyazıyı MP4 içine gömme. Altyazılar ayrı dosya kalır.
- Chrome Web Store yayını. Eklenti "paketlenmemiş" olarak yüklenir.

## Başarısızlık sayılacak durumlar

- MP4 dosyası yaygın oynatıcılarda açılmıyorsa veya ses-görüntü kaymışsa.
- Birden çok ses varken MP4'te sadece tek ses varsa.
- Reklam videosu (preroll) asıl bölüm yerine indirilirse.
- Tarayıcı kapatıldığında veya eklenti penceresi kapandığında indirme duruyorsa.

## Kararlar

- Çıktı: `Ad\Ad.S02E06.mp4` + `Ad\Ad.S02E06.tr.srt`, `Ad\Ad.S02E06.en.srt`.
  Filmlerde: `Ad (Yıl)\Ad (Yıl).mp4`.
- Mimari: tarayıcı eklentisi + bilgisayarda çalışan yardımcı program (`ffmpeg` kullanır).
- Arayüz: üç giriş birlikte —
  (A) araç çubuğu penceresi "Bu sayfa" sekmesi,
  (B) "Kuyruk" sekmesi,
  (C) oynatıcının köşesinde "İndir" düğmesi.
- Kuyruğa hem tek bölüm hem bütün sezon eklenebilir.
- Video adresleri genel yöntemle (ağ trafiğini izleyerek) bulunur; sezon için bölümler arka
  planda açılır.

## Genel teknikler

- HLS ana listesi (`master`) ile medya listeleri ayrı gelir. Ana liste kaliteleri, ses
  kanallarını ve altyazı kanallarını tanımlar.
- Bazı oynatıcılar altyazıları sayfa metninde düz JSON olarak verir (`file`, `label`, `kind`,
  `lang`). Tarayıcı tarafı bunu satır içi script metninden okur.
- Parça uzantısı içeriği belirlemez: `.jpg` uzantılı parça düz MPEG-TS olabilir (ilk bayt
  `0x47`). Parçalar farklı alan adlarından gelebilir.
- Parça istekleri çoğu zaman doğru `Referer` ister.
- Bazı oynatıcılar iframe'i tıklanana kadar yüklemez (`data-src`).
- Bazı sunucular oynatma listelerini yalnızca oynatıcı çerçevesinin kendisine verir.
  "Çerçeve içinde okuma" bölümüne bakın.

## Mimari

```
┌──────────── Tarayıcı (Chrome / Brave / Edge) ────────────┐
│ content/scan.js   (her çerçeve) altyazı URL'si tarar,    │
│                    sayfa başlığı + bölüm linkleri toplar │
│ content/overlay.js (üst çerçeve) "İndir" düğmesi         │
│ background.js     webRequest ile HLS/MP4/VTT yakalar,     │
│                    sekme başına medya listesi tutar,      │
│                    sezon için arka plan sekmesi açar      │
│ popup.html        "Bu sayfa" + "Kuyruk" sekmeleri         │
│ DNR kuralları     DevTools algılayıcıları boş koda yönlendir │
└──────────────┬───────────────────────────────────────────┘
               │ 1) sendNativeMessage("hello") → {port, token}
               │ 2) fetch http://127.0.0.1:port/api/... (X-Token)
┌──────────────▼───────────────────────────────────────────┐
│ helper/host.js   native messaging: daemon'u başlatır     │
│ helper/daemon.js HTTP API, iş kuyruğu (jobs.json)        │
│   lib/hls.js       m3u8 ayrıştırma                       │
│   lib/download.js  paralel parça indirme, AES-128, devam │
│   lib/subtitles.js VTT→SRT, HLS altyazı birleştirme      │
│   lib/mux.js       ffmpeg ile MP4 (çoklu ses)            │
└──────────────────────────────────────────────────────────┘
```

Neden daemon: native messaging süreci, eklenti bağlantısı kapanınca kapanır. MV3 service
worker 30 sn boşta kalınca durur. İndirmenin tarayıcıdan bağımsız sürmesi için ayrı süreç
gerekir. `host.js` sadece daemon'u başlatır ve port + token verir.

### Eklenti

- Manifest V3. İzinler: `webRequest`, `declarativeNetRequest`, `storage`, `tabs`, `scripting`,
  `nativeMessaging`, `windows`; host izni `<all_urls>`.
- Manifest'te sabit `key` → sabit eklenti kimliği. Yükleyici bu kimliği native host
  manifest'ine yazar.
- **Yakalama:** `webRequest.onBeforeSendHeaders` (extraHeaders) istek başlıklarını
  (Referer, Origin, User-Agent, Cookie) saklar; `onHeadersReceived` cevap türüne bakar:
  - `mpegurl` içeren Content-Type veya `.m3u8` → HLS kaynağı.
  - `video/mp4` veya `.mp4` (media türü, > 5 MB) → doğrudan dosya.
  - `text/vtt`, `.vtt`, `.srt` → altyazı.
- **Sayfa taraması:** `scan.js` her çerçevede HTML ve satır içi script metninde altyazı
  URL'lerini (`"file":"...vtt"` ve etiket/dil) arar; MutationObserver ile yeni scriptleri de
  tarar. Üst çerçeve başlık bilgisi (`document.title`, `og:title`, `h1`, URL) ve bölüm
  linklerini gönderir.
- **Başlık ayrıştırma** (`lib/titles.js`, saf fonksiyon): URL ve başlıktan
  `{kind: episode|movie, name, season, episode, year}`. Örnek kalıplar:
  `/dizi/<slug>/<S>-sezon/<E>-bolum`, `2. Sezon 6. Bölüm`, `S02E06`, `season-2-episode-6`,
  slug sonunda `-2026`. Kullanıcı popup'ta adı/sezonu/bölümü düzeltebilir.
- **Kaynak seçimi:** Popup her HLS kaynağını yardımcıya `probe` ettirir. Bir master
  listesinin alt listesi olan kaynaklar gizlenir. Birden fazla kaynak varsa en uzun süreli
  olan varsayılan (reklamı eler); kullanıcı açılır listeden değiştirebilir.
- **DevTools koruması:** declarativeNetRequest kuralları, DevTools algılayıcı script
  isteklerini eklentideki `stubs/devtools-noop.js` dosyasına yönlendirir. Bu dosya yaygın
  algılayıcı adlarını zararsız boş nesnelerle tanımlar; böylece sitenin kodu hata vermez.
- **Oynatıcı tetikleme:** Video yakalanmadıysa popup "Oynatıcıyı başlat" der. Bu işlem
  `data-src`'li boş iframe'lere `src` verir ve çerçevelerdeki `<video>`'yu sessiz oynatmayı
  dener. Sezon çözümlemede bu işlem otomatik yapılır.
- **Sezon:** Üst çerçevedeki linkler başlık ayrıştırıcıdan geçer; aynı dizi + aynı sezona ait
  bölümler listelenir. Kullanıcı işaretler. Arka plan, kullanıcının penceresinin sağ alt
  köşesinde küçük, sessiz ve odaksız bir pencerede her bölümü sırayla açar, oynatıcıyı
  tetikler, kaynak + altyazı yakalanınca (en çok 60 sn) sekmeyi kapatır ve işi kuyruğa ekler.
  Pencere küçültülmez: küçültülmüş pencerede sayfa gizli sayılır ve tarayıcı videoyu
  yüklemez. İki denemede video bulunmazsa tetikleyici, üst çerçevedeki "oynat" kapaklarına
  da tıklar. Aynı bölüm iki kez kuyruğa girmez. 120 saniyeden kısa kaynaklar (fragman,
  reklam; örneğin sayfadaki YouTube gömmesi) bölüm sayılmaz: çözümleyici süre dolana kadar
  daha uzun bir kaynak bekler, bulamazsa `episode_short` hatası verir.
- **Overlay (C):** Sekmede kaynak bulununca üst çerçeve, görünür en büyük `iframe`/`video`
  öğesinin sağ üst köşesine "⬇ İndir" düğmesi koyar (Shadow DOM). Tıklanınca aynı popup
  sayfası (`popup.html?tab=<id>`) sayfa üzerinde bir panel olarak açılır. Oynatıcı bir poster
  arkasında gizliyse düğme pencerenin sağ alt köşesinde durur.

### Çerçeve içinde okuma (genel teknik)

Bazı sunucular kalite listelerini yalnızca oynatıcı çerçevesinin kendisine verir; yardımcı
programa ve eklentinin arka plan koduna 403/404 döner (örneğin bot koruması arkasında).
Eklenti master listesini ve ona bağlı bütün listeleri, isteği yapan çerçevede
(`chrome.scripting.executeScript`, Referer'ın origin'i) okur ve işe `playlists: {url: metin}`
olarak ekler. Yardımcı bu metinleri kullanır; parçaları (segment) kendisi `Referer` ile
doğrudan indirir. Yöntem bütün sitelerde denenir; okunamazsa yardımcı kendi isteğine geri
döner.

### Yardımcı program (Node 22, harici paket yok)

- **API** (127.0.0.1, rastgele port, her istekte `X-Token`; `Origin` sadece
  `chrome-extension://<id>`):
  `GET /api/ping`, `POST /api/probe`, `GET /api/jobs`, `POST /api/jobs`,
  `POST /api/jobs/:id/{cancel,retry,remove,open}`, `GET|POST /api/settings`.
- **Probe:** m3u8 indirir. Master ise kaliteler (`RESOLUTION`, `BANDWIDTH`), ses kanalları
  (`EXT-X-MEDIA TYPE=AUDIO`: ad, dil, varsayılan), altyazı kanalları döner. Medya listesi
  ise tek kalite + süre döner.
- **İndirme:** Seçilen kalitenin medya listesi + seçilen grubun bütün ses kanalları indirilir.
  Paralel parça, her parça için yeniden deneme. `EXT-X-KEY AES-128` çözülür, `EXT-X-MAP`
  (fMP4) ve `EXT-X-BYTERANGE` desteklenir. Parça başında TS olmayan çöp bayt varsa ilk geçerli
  `0x47` senkronundan kesilir. Parçalar veri klasöründeki `work\<iş>` altında tutulur;
  yeniden başlatmada var olan parçalar atlanır (devam etme).
- **Birleştirme:** `ffmpeg -c copy` ile MP4; bütün ses akışları eşlenir, dil etiketi
  (`tr→tur`, `en→eng` …) ve başlık yazılır, `+faststart`. Video TS içinde birden çok ses
  varsa hepsi alınır. Ayrı ses listeleri video ile aynı zaman çizgisini paylaşır: ffmpeg her
  girişi kendi başına sıfıra çeker, bu yüzden girişlerin başlangıç zamanı (`ffmpeg -i`
  çıktısındaki `start:`) okunur ve fark `-itsoffset` ile geri verilir (fark 10 sn'den
  büyükse hizalama yapılmaz). Birleştirme bitince `ffprobe` ile akış süreleri karşılaştırılır;
  ses/video/playlist süreleri %1'den (en az 2 sn) fazla ayrıksa iş `warning = av_mismatch`
  ile biter ve kuyrukta uyarı görünür.
- **Altyazı:** VTT → SRT (zaman biçimi, cue ayarları atılır, numaralandırma), UTF-8 BOM'lu.
  Dil kodu `lang` alanından; yoksa etiketten (Türkçe/Turkish → `tr` …) ya da URL'den.
  Aynı dilde iki altyazı varsa `.tr.2.srt`.
- **Kuyruk:** Aynı anda bir iş. Durumlar: `queued`, `downloading`, `muxing`, `done`, `failed`,
  `canceled`. `jobs.json` ile kalıcı. 403/410 hatalarında mesaj: "Bağlantının süresi doldu —
  Yeniden dene" (yeniden dene, eklenti tarafından sayfa yeniden açılarak adresler tazelenir).
- **Tek daemon.** Tarayıcı aynı anda birkaç native mesaj gönderebilir. `host.js` bir kilit
  dosyası kullanır; `daemon.js` açılışta çalışan başka bir daemon varsa kapanır.
- **Daemon başlatma.** `host.js` daemon'u WMI (`Win32_Process.Create`) ile başlatır; böylece
  tarayıcının native host iş nesnesine (job object) bağlı kalmaz ve tarayıcı kapansa da
  çalışır.
- **ffmpeg:** veri klasöründeki `ffmpeg\bin\ffmpeg.exe`, yoksa PATH.
- **Kurulum:** `install.ps1` — Node kontrolü, ffmpeg indirme (BtbN GitHub sürümü, curl ile),
  native host manifest'i yazma, HKCU altında Chrome, Brave ve Edge için kayıt.

### Uyarlanabilir indirme

- `lib/throttle.js`: uyarlanabilir bağlantı sınırı (başlangıç 4, en çok 16, en az 2). Her 4 sn
  hız ölçülür; artış %8'den azsa son ekleme geri alınır ve 30 sn beklenir. Hata/bozuk parçada
  sınır yarıya iner.
- Parça doğrulama: `text/html`/JSON cevap, TS senkronu / ID3 / ADTS / fMP4 kutusu olmayan
  veri reddedilir ve yeniden denenir (hız sınırı sırasında 200 ile gelen sahte cevaplar).
- `concatf:` ile ffmpeg parçaları doğrudan okur; birleştirilmiş ara dosya yok. ffmpeg liste
  satırlarında ters eğik çizgiyi kabul etmiyor: `file:` + `/` kullanılır.
- `#EXT-X-DISCONTINUITY`: etiketten sonra zaman damgaları sıçrar; düz birleştirme + `-c copy`
  bu sıçramayı dosyaya taşır (görüntü donar, ses kayar). Parçalar süreksizlik gruplarına
  ayrılır; her grup kendi `concatf:` listesidir, gruplar concat demuxer'ı ile
  (`-f concat -safe 0 -protocol_whitelist file,concatf,concat`) sürekli zaman damgasıyla
  birleşir. fMP4'te her grup kendi `#EXT-X-MAP` init parçasını alır.
- HTTP zaman aşımı toplam değil boşta kalma süresidir (30 sn veri gelmezse). Yavaş ama canlı
  bir parça indirmesi zaman aşımına uğramaz.
- `job.stats` ve `daemon.log`: indirme süresi, bayt, ortalama hız, en yüksek/son bağlantı,
  yeniden deneme, MP4 süresi.

### YouTube

Kendi çözücümüz yerine `yt-dlp` kullanılır (YouTube sık değişir; yt-dlp bunu takip eder).
- Sistem sertifika deposu gerekiyorsa: `--compat-options no-certifi`.
- İmza çözümü için JS motoru gerekir: `--js-runtimes node:<node.exe>`,
  `--remote-components ejs:github`.
- Biçim seçimini yardımcı yapar (`selectFormats`): yükseklik sınırı içinde önce H.264, dil
  başına bir ses (önce AAC, DRC hariç). Varsayılan diller: orijinal + Türkçe.
  `--load-info-json` ile ikinci çözümleme yapılmaz.
- yt-dlp birleştirmede dublaj seslerine dil etiketi koymuyor ve hepsini varsayılan yapıyor:
  `--postprocessor-args "Merger+ffmpeg_o:..."` ile dil, başlık ve tek varsayılan yazılır.
- Klasör = kanal (`meta.kind = 'video'`), liste işlerinde klasör = liste adı, dosya
  `NN - Başlık`.
- Çerezler `chrome.cookies` ile alınır, `yt-cookies.txt` dosyasına yazılır; `jobs.json`
  içine girmez.
- YouTube sayfa yenilemeden gezindiği için rozet `tabs.onUpdated` ile, düğme `whoami`
  mesajıyla kurulur. YouTube "Trusted Types" kullanıyor: içerik betiğinde `innerHTML` yasak;
  overlay DOM API ile kurulur. Oyuncu konumu için `#movie_player` tercih edilir.

## Varsayılanlar

- Bütün ses ve altyazılar başta seçili; varsayılan kalite en yüksek.
- MP4'te varsayılan ses: playlist'te `DEFAULT=YES` olan kanal; yoksa ilki.
- Varsayılan klasör: `İndirilenler` (Downloads). Popup ayarlarından değişir.
- Yardımcı dil: Node.js (bilgisayarda kurulu; ek paket gerekmez).
- Yerel API güvenliği: rastgele token + Origin kontrolü + sadece 127.0.0.1.
- Sezon çözümleme sırayla yapılır (aynı anda bir arka plan sekmesi).

## Test

- Saf fonksiyonlar için `node --test`: m3u8 ayrıştırma, VTT→SRT, başlık ayrıştırma, dosya adı
  temizleme, dil eşleme.
- Yardımcı uçtan uca: gerçek bir HLS akışından ilk birkaç parçayı indirip MP4 yapma,
  `ffprobe` ile akışları doğrulama.
- Eklenti uçtan uca: Brave'i geçici profil + `--remote-debugging-pipe` ile açıp eklentiyi CDP
  `Extensions.loadUnpacked` ile yükleme; yakalanan kaynak ve altyazıları kontrol etme.
