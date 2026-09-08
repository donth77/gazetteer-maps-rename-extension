# Chrome Web Store listing

Copy for the developer dashboard. Screenshots are in `store/screenshots/`.

## Name

Gazetteer

## Short description (132 character limit)

Decide what Google Maps calls things. Restore the Gulf of Mexico, Lake Ontario, or rename any place, on the map and in the page.

## Detailed description

Gazetteer lets you choose the names Google Maps shows you.

Google renamed the Gulf of Mexico and Lake Ontario. Gazetteer puts the old
names back. It also renames anything else you want, from countries and states
to streets, shops and landmarks.

Your names appear everywhere Maps shows the original: the sidebar, search
results, the browser tab title, and the labels drawn on the map itself.

- Two renames are set up for you: Gulf of Mexico and Lake Ontario. Switch
  either one off, or delete it, whenever you like.
- Add your own from the settings page. A rename can apply in one language or
  in all of them.
- Search still works. Type your name for a place and Maps is sent the name it
  knows, while the box keeps showing yours.
- Changes appear in an open Maps tab within a second.
- The interface is available in English, Spanish, French, German, Portuguese,
  Japanese, Korean and Chinese.

Gazetteer changes what you see and nothing else. It does not edit Google Maps,
and other people see the map exactly as before.

Privacy: the extension makes no network requests. Your rules are stored on your
own computer and are never uploaded. There is no account, no analytics, and no
tracking. The source is open: https://github.com/donth77/maps-rename-extension

## Category

Productivity

## Single purpose

Gazetteer has one purpose: to display place names chosen by the user in place
of the names Google Maps shows.

## Permission justifications

**storage**

Stores the user's renaming rules, which are the place names they want changed
and what to change them to. This is the only state the extension keeps, it
lives on the user's own computer in chrome.storage.local, and it is never
transmitted anywhere. Chrome's sync storage is deliberately not used, so the
rules are not uploaded.

**Host access to Google Maps addresses**

To replace a place name, the extension has to read the names Google Maps is
displaying and write the replacements back. It does this in the page text and
in the labels drawn on the map canvas. The match list is the user's own rules.
Nothing is read for any other reason, nothing is recorded, and nothing leaves
the browser. The extension declares only Google Maps addresses and has no
access to any other site.

**Remote code**

None. All code is in the package. The extension loads no scripts and makes no
network requests.

## Data usage disclosures

Nothing is collected. Answer "no" to every data type, and confirm all three
certifications: the data is not sold, not used for unrelated purposes, and not
used for creditworthiness or lending.

## Privacy policy URL

https://github.com/donth77/maps-rename-extension/blob/main/PRIVACY.md
