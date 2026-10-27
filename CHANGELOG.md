# Journal des nouveautés

Toutes les évolutions notables du module « Comparateur de rasters (rideau / loupe) ». Le format suit
[Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) et le versionnement
[SemVer](https://semver.org/lang/fr/).

Ce fichier est affiché dans GEO, dans la fenêtre « Nouveautés » du module : il s'écrit pour les
**utilisateurs**, en français, pas pour les développeurs (la liste des commits est dans git). La version
la plus récente publiée doit être celle de `package.json` et de `src/plugin.geoext.json`
(`npm test` le vérifie).

## [Non publié]

### Corrigé

- Fonds de plan GEO : un fond de plan ajouté dans la partie carte de l'application (et non dans Données → Fonds
  de plan) était proposé dans les menus mais ne s'affichait pas une fois choisi. Il s'affiche désormais comme les
  autres fonds de plan

## [0.3.1] — 2026-10-24

### Modifié

- Catalogue CRAIG : la liste des couches est désormais lue directement auprès du CRAIG à l'ouverture du
  comparateur, au lieu d'être figée dans le module. Les nouveaux millésimes et les nouvelles prises de vues
  apparaissent sans mise à jour du module, et leurs titres sont toujours à jour. Si le service du CRAIG ne répond
  pas, un message l'indique et les autres rasters restent disponibles

## [0.3.0] — 2026-10-24

### Ajouté

- Catalogue CRAIG : nouvelle option « Inclure le catalogue CRAIG » qui ajoute aux menus les orthophotographies du
  CRAIG et de ses partenaires en Auvergne-Rhône-Alpes (millésimes de 1993 à 2025, ortho historique 1948-1954 et
  prises de vues locales à haute résolution). Le titre de chaque couche indique les départements couverts. Option
  désactivée par défaut

## [0.2.0] — 2026-10-24

Première version publiée du module : comparer deux rasters directement sur la carte principale de l'application.

### Ajouté

- Mode « Rideau » : un curseur déplaçable sépare le raster de gauche et celui de droite
- Mode « Loupe » : le raster de droite n'apparaît que dans un cercle qui suit la souris
- Catalogue IGN : dernière orthophoto, éditions de 2003 à 2021 et prises de vues historiques 1950-1980
- Les fonds de plan configurés dans GEO (WMTS, WMS, XYZ) peuvent être comparés, en plus du catalogue IGN ; réglage
  « Fonds de plan GEO à comparer » dans le Générateur
- Réglage « Emplacement des menus » : barre sur la carte ou panneau latéral
- Réglages du Générateur : rasters de départ à gauche et à droite, mode initial, rayon de la loupe, libellé et
  position du bouton
- Fenêtre « Nouveautés » : le lien « v0.2.0 · Nouveautés » de la barre de comparaison (ou du panneau latéral)
  ouvre ce journal, avec un point rouge tant que la dernière version n'a pas été lue
