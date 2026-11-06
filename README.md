# Eetmeter

Een gratis app om je calorieën en voedingswaardes bij te houden. Je hebt geen account of abonnement nodig.

- **Foto van je eten**: Google Gemini herkent wat er op je bord ligt en schat de grammen.
- **Beschrijven**: typ bijvoorbeeld "2 boterhammen met kaas" en Gemini rekent het uit.
- **Barcode scannen** en **product zoeken**: via Open Food Facts, met exacte waardes van de verpakking.
- **Daglog** met kcal, eiwit, koolhydraten, vet en vezels, en een dagdoel.
- **Profielen**: meerdere mensen op één telefoon, ieder met een eigen daglog en doel. Een korte vragenlijst (leeftijd, lengte, gewicht, doel, activiteit) berekent je dagelijkse kcal en eiwit met de Mifflin-St Jeor-formule. Bij afvallen ligt het advies nooit meer dan 25% onder je verbruik en nooit onder 1200 kcal (vrouw) of 1500 kcal (man), en een streefgewicht onder een gezonde BMI (18,5) wordt niet geaccepteerd.
- **Advies** per maaltijd en per dag, op basis van de Schijf van Vijf. Je krijgt een oordeel (goed / redelijk / kan beter) en concrete alternatieven, zoals "in plaats van wit brood → 2 sneetjes volkorenbrood".
- **Nutri-Score** (A t/m E) bij gescande producten, als Open Food Facts die kent.

Alles wat je invoert blijft in de browser op je telefoon; er draait geen server. Het is een webpagina die je als app op je beginscherm zet.

## 1. Gratis Gemini API-key aanmaken (eenmalig)

1. Ga naar https://aistudio.google.com/apikey en log in met een Google-account.
2. Klik op **Create API key** en kopieer de key.
3. Open Eetmeter, ga naar **Instellingen** en plak de key. Druk op **Verbinding testen**.

Goed om te weten over de gratis laag:
- Er zit een limiet op het aantal verzoeken per minuut en per dag. Voor een paar maaltijden per dag is dat ruim genoeg. Zit je erboven, dan probeert de app automatisch een ander gratis model.
- Google mag wat je via de gratis laag instuurt (dus je eten-foto's) gebruiken om hun producten te verbeteren.
- Je hoeft geen betaalgegevens in te vullen. Doe dat ook niet, dan kun je nooit per ongeluk betalen.

## 2. De app op je telefoon zetten

De camera en de barcodescanner werken alleen via **https**. De makkelijkste gratis manier om dat te krijgen is **GitHub Pages**:

1. Maak een gratis account op https://github.com en maak een nieuwe repository, bijvoorbeeld `eetmeter`.
2. Upload alle bestanden uit deze map (`index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.webmanifest`, de map `icons`).
3. Ga naar **Settings → Pages**, kies bij *Branch* `main` en klik op **Save**.
4. Na een minuut staat de app op `https://<jouw-naam>.github.io/eetmeter/`.
5. Open die link op je telefoon:
   - **iPhone (Safari)**: deelknop → **Zet op beginscherm**.
   - **Android (Chrome)**: menu ⋮ → **App installeren** of **Toevoegen aan startscherm**.

Je API-key staat niet in die bestanden. Die vul je alleen op je telefoon in, dus de link kan geen kwaad.

## 3. Tips voor betere schattingen

- Fotografeer schuin van boven, met het hele bord in beeld.
- Gebruik **Extra info** voor wat je niet ziet: "gebakken in 2 el olie", "met mayo".
- Controleer altijd de grammen. Een foto laat geen gewicht zien, dus aanpassen is normaal.
- Voor verpakte producten zijn barcode en zoeken nauwkeuriger dan een foto.

## Back-up

Je gegevens staan alleen in de browser van je telefoon. Als je de browsergegevens wist, ben je ze kwijt. Gebruik daarom af en toe **Instellingen → Exporteren**.

## Later overstappen naar lokaal

Bij **Instellingen → Dienst** kun je **Ollama** kiezen. Dan draait de AI op je eigen pc in plaats van bij Google. Daarvoor moet Ollama geïnstalleerd zijn, met een visiemodel (bijvoorbeeld `ollama pull gemma3:4b`) en `OLLAMA_ORIGINS=*` ingesteld. Op een pc zonder losse videokaart is dit traag.

## Testen op je pc

```bash
python -m http.server 8765 --directory eetmeter
```

Open daarna http://localhost:8765.
