# Sistema prenotazioni ristorante

## Come si usa
1. Fai doppio clic su **`avvia.bat`** (serve Node.js 22 o più recente). Si apre da solo il sito `http://localhost:3000`.
2. Lascia aperta la finestra nera mentre lavori. Per spegnere il sistema, chiudila.
3. Accedi con utente `admin`. La password del primo avvio è nel file `data/PRIMO-ACCESSO.txt`
   (cambiala da Impostazioni, poi cancella quel file).

**Non aprire mai `public/index.html` con doppio clic**: da solo non può collegarsi ai dati e non permette di accedere.
Il sito va sempre aperto da `http://localhost:3000` (lo fa `avvia.bat`).

## Sala: aree, turni e tavoli uniti
- La schermata **Prenotazioni** si filtra per **Area** (Sala, Piazzetta, Veranda…), **Servizio** (pranzo/cena) e **Turno** (1° e 2°).
- In alto vedi tavoli occupati e liberi, coperti prenotati e prenotazioni in ritardo. **Elenco** mostra la tabella dei clienti, **Tavoli** la pianta con un riquadro per tavolo.
- Per cambiare tavolo tocca il nome del tavolo (o «Cambia tavolo») e scegli. **Per unire i tavoli tocca più tavoli**: i posti si sommano (es. 10 persone su Tavolo 1 + 2 + 3 + 4).
- Se per tante persone non basta un tavolo solo, il sistema propone da solo tavoli vicini (numerazione consecutiva nella stessa area).
- In **Impostazioni** si creano le aree e i tavoli (anche molti insieme) e si regolano gli orari dei turni e dopo quanti minuti una prenotazione risulta in ritardo.
- «Tema chiaro / Tema scuro» in alto cambia i colori.

## Password dimenticata
Fai doppio clic su **`reimposta-password.bat`**: scrive una nuova password per `admin`.

## Dati
Tutto è nel file `data/ristorante.db`. Ogni giorno viene fatta una copia in `data/backup/` (ultimi 30 giorni).
Copia ogni tanto la cartella `data` su una chiavetta o su cloud.

## Invio SMS / email (facoltativo)
Senza configurazione i messaggi restano "in coda" nella pagina Messaggi e l'avviso nuove prenotazioni compare a schermo.
Per l'invio reale imposta queste variabili d'ambiente prima di avviare:
- SMS (Twilio): `TWILIO_SID`, `TWILIO_TOKEN`, `TWILIO_FROM`
- Email (Resend): `RESEND_KEY`, `MAIL_FROM`
