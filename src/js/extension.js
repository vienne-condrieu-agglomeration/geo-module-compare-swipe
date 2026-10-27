/**
 * geo-compare-swipe — comparaison de deux rasters (rideau ou loupe) directement sur la
 * carte OpenLayers principale de l'application GEO, avec ol-ext (Jean-Marc Viglino).
 *
 * Inspiré du script communautaire « geo_swipe_control » (Malo Tartevet, Quimperlé Communauté,
 * licence Beerware, puis Pierre C du CD 07), réécrit sous forme de module.
 */
import angular from "angular";
import pluginConf from '../plugin.geoext.json';

// ol-ext enrichit le `ol` global de GEO (ol.control.Swipe, ol.interaction.Clip…).
import 'ol-ext/dist/ol-ext.js';
import 'ol-ext/control/Swipe.css';

import { createChangelog } from './changelog.js';
import changelogMd from '../../CHANGELOG.md';

angular
    .module(pluginConf.code.moduleName, pluginConf.code.dependencies)
    .run(['geoApplication', 'acfExtensionService', '$rootScope', '$injector',
          function (geoApplication, acfExtensionService, $rootScope, $injector) {

        // Journal des nouveautés : lien dans la barre de comparaison et dans le panneau latéral
        var changelog = createChangelog({
            name: pluginConf.name, title: pluginConf.displayName, version: pluginConf.version,
            markdown: changelogMd, prefix: 'geo-compare-swipe'
        });

        // ============================================================
        // Configuration (remplie depuis le générateur GEO)
        // ============================================================
        // Le Générateur affiche les `values` du manifeste et ignore `labels` : les valeurs sont
        // les textes français, convertis ici.
        var _PLACEMENTS = { 'Sur la carte': 'map', 'Panneau latéral': 'panel' };
        var _MODES      = { 'Rideau (curseur)': 'swipe', 'Loupe': 'loupe' };
        var _TOOL_POSITIONS = {
            'Haut gauche': 'topleft', 'Haut centre': 'topcenter', 'Haut droite': 'topright',
            'Milieu gauche': 'left', 'Milieu droite': 'right',
            'Bas gauche': 'bottomleft', 'Bas centre': 'bottomcenter', 'Bas droite': 'bottomright'
        };

        var _includeIgn   = true;
        var _includeCraig = false;
        var _geoLayers    = [];   // fonds de plan GEO choisis dans le Générateur
        var _leftDefault  = '';
        var _rightDefault = '';
        var _placement    = 'map';
        var _defaultMode  = 'swipe';
        var _loupeRadius  = 150;
        var _toolName     = 'Comparer des rasters';
        var _toolPosition = 'topright';
        var _registered   = false;

        // Au-dessus des fonds de plan GEO, sous les couches thématiques.
        var _Z_LEFT  = 998;
        var _Z_RIGHT = 999;

        // ============================================================
        // Catalogue des rasters
        // ============================================================
        var _IGN_WMTS = 'https://data.geopf.fr/wmts';

        function _ignEntry(id, label, layer, format, extra) {
            var e = { id: id, label: label, group: 'IGN', type: 'wmts', url: _IGN_WMTS,
                      layer: layer, format: format || 'image/jpeg' };
            for (var k in (extra || {})) { e[k] = extra[k]; }
            return e;
        }

        function _ignCatalogue() {
            var list = [_ignEntry('ortho_ign_2024', 'Ortho IGN (dernière édition)', 'HR.ORTHOIMAGERY.ORTHOPHOTOS')];
            ['2021', '2018', '2014', '2010', '2006', '2003'].forEach(function (y) {
                list.push(_ignEntry('ortho_ign_' + y, 'Ortho IGN ' + y, 'ORTHOIMAGERY.ORTHOPHOTOS' + y));
            });
            // Orthos historiques : PNG uniquement ; couverture variable selon les territoires.
            list.push(_ignEntry('ortho_ign_1950_1965', 'Ortho IGN 1950-1965',
                'ORTHOIMAGERY.ORTHOPHOTOS.1950-1965', 'image/png'));
            list.push(_ignEntry('ortho_ign_1965_1980', 'Ortho IGN 1965-1980',
                'ORTHOIMAGERY.ORTHOPHOTOS.1965-1980', 'image/png',
                { matrixSet: 'PM_3_18', minZoom: 3, maxZoom: 18, style: 'BDORTHOHISTORIQUE' }));
            return list;
        }

        // Orthophotographies du CRAIG et de ses partenaires (WMTS public, CORS ouvert). La liste n'est pas codée
        // en dur : elle est lue dans le GetCapabilities du service (environ 48 Ko) quand l'option est active, si bien
        // qu'un nouveau millésime apparaît sans mettre le module à jour. Sans réponse du CRAIG, ses fonds de plan
        // ne sont de toute façon pas disponibles : il n'y a donc pas de liste de secours.
        var _CRAIG_WMTS = 'https://tiles.craig.fr/ortho/service';
        var _craigEntries = [];     // entrées construites depuis le GetCapabilities
        var _craigLoaded  = false;
        var _craigLoading = null;   // lecture en cours : une seule requête à la fois

        function _craigEntryFrom(layer) {
            var links = layer.TileMatrixSetLink || [];
            var matrixSet = null;
            links.forEach(function (l) { if (!matrixSet && l.TileMatrixSet === 'webmercator') { matrixSet = l.TileMatrixSet; } });
            if (!matrixSet && links.length) { matrixSet = links[0].TileMatrixSet; }
            if (!layer.Identifier || !matrixSet) { return null; }   // couche inutilisable : ignorée
            var styles = layer.Style || [], style = null;
            styles.forEach(function (st) { if (st.isDefault && !style) { style = st.Identifier; } });
            if (!style && styles.length) { style = styles[0].Identifier; }
            return { id: 'craig_' + layer.Identifier, label: layer.Title || layer.Identifier, group: 'CRAIG',
                     type: 'wmts', fromCapabilities: true, url: _CRAIG_WMTS, layer: layer.Identifier,
                     matrixSet: matrixSet, style: style, format: (layer.Format || ['image/png'])[0] };
        }

        function _loadCraigCatalogue() {
            if (_craigLoaded) { return Promise.resolve(); }
            if (_craigLoading) { return _craigLoading; }
            _craigLoading = _fetchWmtsCapabilities(_CRAIG_WMTS).then(function (caps) {
                var layers = (caps.Contents && caps.Contents.Layer) || [];
                _craigEntries = layers.map(_craigEntryFrom).filter(Boolean);
                _craigLoaded = true;
                _craigLoading = null;
            }, function (e) {
                _craigLoading = null;   // une prochaine ouverture retentera la lecture
                console.error('[geo-compare-swipe] Catalogue du CRAIG indisponible :', e);
                throw e;
            });
            return _craigLoading;
        }

        // Fonds de plan GEO (Données → Fonds de plan) glissés dans le Générateur.
        // Seul l'identifiant est retenu ici : le descripteur (`geoApplication._baseLayers`) n'est
        // peuplé qu'après l'initialisation complète de l'application, il est lu à l'usage.
        function _normalizeGeoLayer(item) {
            var f = item.functionality || item;
            var id = f.targetId || f.id || item.targetId || item.id || null;
            var name = item.label || f.name || 'Fond de plan';
            return { id: 'geo:' + (id || name), label: name, group: 'Fonds de plan GEO',
                     type: 'geo', descriptorId: id, descriptorName: f.name || name };
        }

        // Tableau partagé avec le gabarit du panneau : toujours modifié sur place, jamais remplacé.
        var _catalogue = [];

        function _buildCatalogue() {
            var list = _geoLayers.slice();
            if (_includeIgn) { list = list.concat(_ignCatalogue()); }
            if (_includeCraig) { list = list.concat(_craigEntries); }
            _catalogue.length = 0;
            Array.prototype.push.apply(_catalogue, list);
        }

        function _getItem(id) {
            for (var i = 0; i < _catalogue.length; i++) {
                if (_catalogue[i].id === id) { return _catalogue[i]; }
            }
            return null;
        }

        // Réglages « raster initial » : identifiant ou libellé affiché dans les menus.
        function _findByIdOrLabel(text) {
            if (!text) { return null; }
            var byId = _getItem(text);
            if (byId) { return byId; }
            for (var i = 0; i < _catalogue.length; i++) {
                if (_catalogue[i].label === text) { return _catalogue[i]; }
            }
            return null;
        }

        // Grille WMTS « PM » (Web Mercator, EPSG:3857) de la Géoplateforme IGN, codée en dur
        // plutôt que lue dans le GetCapabilities (plusieurs Mo). OpenLayers reprojette les
        // tuiles si la carte GEO est en Lambert 93.
        function _pmTileGrid(minZ, maxZ, padIds) {
            var size = 40075016.68557849 / 256, resolutions = [], matrixIds = [];
            for (var z = minZ || 0; z <= (maxZ || 21); z++) {
                resolutions.push(size / Math.pow(2, z));
                matrixIds.push(padIds && z < 10 ? '0' + z : String(z));
            }
            return new ol.tilegrid.WMTS({
                origin: [-20037508.342789244, 20037508.342789244],
                resolutions: resolutions,
                matrixIds: matrixIds
            });
        }

        // ---- Fonds de plan GEO : descripteur → source OpenLayers ----
        var _wmtsCapsCache = {};

        // Fonds de plan ajoutés dans la partie carte : absents de `_baseLayers` (copie de
        // `state.baseLayers`), leur descripteur est dans `state.resources`, avec la même forme.
        function _mapResources() {
            var store = geoApplication._map && geoApplication._map.store;
            var state = store && store.getState ? store.getState() : null;
            return (state && state.resources) || {};
        }

        function _findDescriptor(all, bm) {
            if (bm.descriptorId && all[bm.descriptorId] && all[bm.descriptorId].connection) {
                return all[bm.descriptorId];
            }
            var found = null;
            Object.keys(all).forEach(function (k) {
                if (!found && all[k] && all[k].connection && all[k].name === bm.descriptorName) { found = all[k]; }
            });
            return found;
        }

        function _getDescriptor(bm) {
            return _findDescriptor(geoApplication._baseLayers || {}, bm) || _findDescriptor(_mapResources(), bm);
        }

        function _capabilitiesUrl(serviceUrl) {
            var join = serviceUrl.indexOf('?') >= 0 ? (/[?&]$/.test(serviceUrl) ? '' : '&') : '?';
            return serviceUrl + join + 'SERVICE=WMTS&REQUEST=GetCapabilities&VERSION=1.0.0';
        }

        function _fetchWmtsCapabilities(serviceUrl) {
            if (_wmtsCapsCache[serviceUrl]) { return _wmtsCapsCache[serviceUrl]; }
            var p = fetch(_capabilitiesUrl(serviceUrl))
                .then(function (r) {
                    if (!r.ok) { throw new Error('HTTP ' + r.status); }
                    return r.text();
                })
                .then(function (xml) { return new window.ol.format.WMTSCapabilities().read(xml); });
            p.catch(function () { delete _wmtsCapsCache[serviceUrl]; });
            _wmtsCapsCache[serviceUrl] = p;
            return p;
        }

        function _geoWmtsSource(conn) {
            var layer = conn.layer || {};
            return _fetchWmtsCapabilities(conn.url).then(function (caps) {
                var attempts = [
                    { layer: layer.layerIdentifier, matrixSet: layer.tileMatrixSetIdentifier, style: layer.style, format: layer.format },
                    { layer: layer.layerIdentifier, matrixSet: layer.tileMatrixSetIdentifier },
                    { layer: layer.layerName,       matrixSet: layer.tileMatrixSetIdentifier }
                ];
                var opts = null;
                attempts.forEach(function (a) {
                    if (opts) { return; }
                    var cfg = {};
                    Object.keys(a).forEach(function (k) { if (a[k]) { cfg[k] = a[k]; } });
                    try { opts = window.ol.source.WMTS.optionsFromCapabilities(caps, cfg); } catch (e) { opts = null; }
                });
                if (!opts) {
                    throw new Error('optionsFromCapabilities a échoué pour ' +
                        (layer.layerIdentifier || layer.layerName));
                }
                return new window.ol.source.WMTS(opts);
            });
        }

        function _geoWmsSource(conn, descriptorId) {
            // WMS proxifié/authentifié : GEO expose un proxy par identifiant.
            var url = conn.proxyAccess ? ('services/aas/v1/wmsWrapper/proxy/' + descriptorId) : conn.url;
            // Tableau dans `_baseLayers`, objet indexé ({0: …}) dans `state.resources`.
            var layers = Object.values(conn.layers || {});
            return new window.ol.source.TileWMS({
                url: url,
                params: {
                    LAYERS:      layers.map(function (l) { return l.layerName; }).join(','),
                    STYLES:      layers.map(function (l) { return l.style || ''; }).join(','),
                    FORMAT:      conn.imageFormat || 'image/png',
                    TRANSPARENT: 'TRUE',
                    VERSION:     conn.version || '1.3.0'
                }
            });
        }

        function _buildGeoSource(bm) {
            var descriptor = _getDescriptor(bm);
            if (!descriptor || !descriptor.connection) {
                return Promise.reject(new Error('fond de plan « ' + bm.label + ' » introuvable dans l\'application'));
            }
            var conn = descriptor.connection, type = conn['@type'] || '';
            if (/WMTSWebServiceConnection/.test(type) || (conn.encoding === 'KVP' && conn.layer)) {
                return _geoWmtsSource(conn);
            }
            if (/WMSWebServiceConnection/.test(type)) {
                return Promise.resolve(_geoWmsSource(conn, descriptor.id));
            }
            if (/(XYZ|TMS)WebServiceConnection/.test(type) || conn.type === 'xyz' || conn.type === 'tms') {
                return Promise.resolve(new window.ol.source.XYZ({ url: conn.url }));
            }
            return Promise.reject(new Error('type de connexion non géré : ' + type));
        }

        // Retourne une promesse de source OpenLayers.
        function _buildSource(bm) {
            var ol = window.ol;
            if (bm.type === 'geo') { return _buildGeoSource(bm); }
            if (bm.type === 'wms') {
                return Promise.resolve(new ol.source.TileWMS({
                    url: bm.url,
                    params: { LAYERS: bm.layer, FORMAT: bm.format || 'image/png',
                              TRANSPARENT: true, VERSION: bm.version || '1.3.0' }
                }));
            }
            if (bm.type === 'xyz') { return Promise.resolve(new ol.source.XYZ({ url: bm.url })); }
            if (bm.fromCapabilities) {
                return _fetchWmtsCapabilities(bm.url).then(function (caps) {
                    var cfg = { layer: bm.layer, matrixSet: bm.matrixSet, format: bm.format };
                    if (bm.style) { cfg.style = bm.style; }
                    var opts = ol.source.WMTS.optionsFromCapabilities(caps, cfg);
                    if (!opts) { throw new Error('couche « ' + bm.layer + ' » absente du GetCapabilities'); }
                    return new ol.source.WMTS(opts);
                });
            }
            return Promise.resolve(new ol.source.WMTS({
                url: bm.url,
                layer: bm.layer,
                matrixSet: bm.matrixSet || 'PM',
                format: bm.format || 'image/png',
                style: bm.style || 'normal',
                projection: 'EPSG:3857',
                tileGrid: _pmTileGrid(bm.minZoom, bm.maxZoom, bm.padMatrixIds)
            }));
        }

        // ============================================================
        // Moteur de comparaison (partagé par les deux interfaces)
        // ============================================================
        var _map        = null;   // ol.Map principale de GEO
        var _swipe      = null;   // ol.control.Swipe
        var _loupe      = null;   // ol.interaction.Clip
        var _leftLayer  = null;
        var _rightLayer = null;
        var _ringEl     = null;   // contour HTML de la loupe
        var _moveHandler = null;

        var _state = { active: false, mode: 'swipe', leftId: null, rightId: null, error: null };
        var _listeners = [];

        function _snapshot() {
            return { active: _state.active, mode: _state.mode, leftId: _state.leftId,
                     rightId: _state.rightId, error: _state.error };
        }
        function _emit() {
            var s = _snapshot();
            _listeners.forEach(function (fn) { try { fn(s); } catch (e) { console.error(e); } });
        }
        function _subscribe(fn) {
            _listeners.push(fn);
            return function () {
                var i = _listeners.indexOf(fn);
                if (i >= 0) { _listeners.splice(i, 1); }
            };
        }

        function _getMap() {
            try {
                var mapView = $injector.get('acfMapService').getMapViewImmediate();
                return mapView && mapView.getNativeMap();
            } catch (e) {
                console.warn('[geo-compare-swipe] Carte GEO introuvable :', e);
                return null;
            }
        }

        function _placeRing(px) {
            if (!_ringEl || !_loupe) { return; }
            var r = _loupe.getRadius();
            _ringEl.style.width  = (2 * r) + 'px';
            _ringEl.style.height = (2 * r) + 'px';
            _ringEl.style.left   = (px[0] - r) + 'px';
            _ringEl.style.top    = (px[1] - r) + 'px';
        }

        // Initialisation unique (la carte peut ne pas être prête au démarrage : on retente au clic).
        function _ensureInit() {
            if (_map) { return true; }
            var ol = window.ol;
            if (!ol || !ol.control || !ol.control.Swipe || !ol.interaction || !ol.interaction.Clip) {
                _state.error = 'ol-ext indisponible : version incompatible avec l\'OpenLayers de GEO.';
                return false;
            }
            var map = _getMap();
            if (!map) {
                _state.error = 'La carte GEO n\'est pas encore prête.';
                return false;
            }
            _map = map;
            _leftLayer  = new ol.layer.Tile({ zIndex: _Z_LEFT });
            _rightLayer = new ol.layer.Tile({ zIndex: _Z_RIGHT });
            _swipe = new ol.control.Swipe();
            // Couches enregistrées une fois : Swipe et Clip ne branchent leurs écouteurs
            // que lorsqu'ils sont présents sur la carte.
            _swipe.addLayer(_leftLayer);
            _swipe.addLayer(_rightLayer, true);
            _loupe = new ol.interaction.Clip({ radius: _loupeRadius, layers: [_rightLayer] });
            _ringEl = document.createElement('div');
            _ringEl.className = 'geo-compare-swipe-ring';
            _ringEl.hidden = true;
            _map.getViewport().appendChild(_ringEl);
            _moveHandler = function (e) {
                if (_state.active && _state.mode === 'loupe') { _placeRing(e.pixel); }
            };
            _map.on('pointermove', _moveHandler);
            return true;
        }

        // La source peut être asynchrone (GetCapabilities) : on ignore une réponse périmée
        // si l'utilisateur a changé de raster entre-temps.
        function _applySource(layer, id) {
            var bm = _getItem(id);
            if (!bm) { return; }
            layer.set('geoCompareSwipeId', id);
            _buildSource(bm).then(function (source) {
                if (layer.get('geoCompareSwipeId') === id) { layer.setSource(source); }
            }).catch(function (e) {
                console.error('[geo-compare-swipe] Raster « ' + bm.label + ' » :', e);
                _state.error = 'Impossible de charger « ' + bm.label + ' » (' + (e && e.message || e) + ').';
                _emit();
                _state.error = null;
            });
        }

        function _attachTool() {
            if (_state.mode === 'loupe') {
                _map.addInteraction(_loupe);
                var center = _map.getView().getCenter();
                _loupe.setPosition(center);
                _placeRing(_map.getPixelFromCoordinate(center));
                _ringEl.hidden = false;
            } else {
                _map.addControl(_swipe);
            }
        }

        function _detachTool() {
            _map.removeInteraction(_loupe);
            _map.removeControl(_swipe);
            _ringEl.hidden = true;
        }

        function _start() {
            if (_state.active) { return true; }
            if (!_ensureInit()) {
                _emit();
                _state.error = null; // l'erreur est signalée une seule fois
                return false;
            }
            _state.error = null;
            _applySource(_leftLayer,  _state.leftId);
            _applySource(_rightLayer, _state.rightId);
            _map.addLayer(_leftLayer);
            _map.addLayer(_rightLayer);
            _state.active = true;
            _attachTool();
            _emit();
            return true;
        }

        function _stop() {
            if (!_state.active) { return; }
            _detachTool();
            _map.removeLayer(_leftLayer);
            _map.removeLayer(_rightLayer);
            _state.active = false;
            _emit();
        }

        // Choix de l'utilisateur : ils priment sur les réglages « raster initial » quand le catalogue arrive.
        var _touched = { left: false, right: false };

        // Les réglages « raster initial » qui visent une couche du CRAIG ne se résolvent qu'une fois le catalogue lu.
        function _resolveDefaults() {
            if (!_touched.left)  { _state.leftId  = _pickDefault(_leftDefault,  'ortho_ign_1950_1965', 0) || _state.leftId; }
            if (!_touched.right) { _state.rightId = _pickDefault(_rightDefault, 'ortho_ign_2024', 1) || _state.rightId; }
        }

        // Lit le catalogue du CRAIG (si l'option est active) puis reconstruit les menus. La promesse est toujours
        // tenue : en cas d'échec, l'erreur est signalée et le module continue sans les couches du CRAIG.
        function _ensureCatalogue() {
            if (!_includeCraig || _craigLoaded) { return Promise.resolve(); }
            return _loadCraigCatalogue().then(function () {
                _buildCatalogue();
                _resolveDefaults();
                _refreshMenus();
                _emit();
            }, function (e) {
                _state.error = 'Impossible de charger le catalogue du CRAIG (' + (e && e.message || e) + ').';
                _emit();
                _state.error = null;
            });
        }

        function _toggle() {
            if (_state.active) { _stop(); return; }
            _ensureCatalogue().then(_start);
        }

        function _setMode(mode) {
            if (mode !== 'swipe' && mode !== 'loupe') { return; }
            if (_state.mode === mode) { return; }
            if (_state.active) { _detachTool(); }
            _state.mode = mode;
            if (_state.active) { _attachTool(); }
            _emit();
        }

        function _setLeft(id) {
            _touched.left = true;
            _state.leftId = id;
            if (_state.active) { _applySource(_leftLayer, id); }
            _emit();
        }

        function _setRight(id) {
            _touched.right = true;
            _state.rightId = id;
            if (_state.active) { _applySource(_rightLayer, id); }
            _emit();
        }

        // ============================================================
        // Lecture config GEO Generator + enregistrement
        // ============================================================
        geoApplication.executeWhenInitialized(function () {
            var config = geoApplication.getConfigurationByExtensionKey(pluginConf.name);

            if (config && config.length > 0) {
                var props = config[0].properties;

                _includeIgn   = props.includeIgnCatalog !== false && props.includeIgnCatalog !== 'false';
                _includeCraig = props.includeCraigCatalog === true || props.includeCraigCatalog === 'true';
                _geoLayers    = (props.baseLayers || []).map(_normalizeGeoLayer);
                _leftDefault  = (props.leftDefault  || '').trim();
                _rightDefault = (props.rightDefault || '').trim();
                _placement    = _PLACEMENTS[props.menuPlacement] || 'map';
                _defaultMode  = _MODES[props.defaultMode] || 'swipe';
                _loupeRadius  = parseInt(props.loupeRadius, 10) || _loupeRadius;
                _toolName     = props.toolName || _toolName;
                _toolPosition = _TOOL_POSITIONS[props.toolPosition] || 'topright';
            }

            _buildCatalogue();
            _state.mode    = _defaultMode;
            _state.leftId  = _pickDefault(_leftDefault,  'ortho_ign_1950_1965', 0);
            _state.rightId = _pickDefault(_rightDefault, 'ortho_ign_2024', 1);

            if (!_registered) {
                _registered = true;
                _injectStyles();
                if (_placement === 'panel') {
                    _registerWidget();
                } else {
                    _registerMapTool();
                    _buildMapBar();
                }
            }
        });

        // Priorité : réglage du Générateur, puis les deux premiers fonds de plan GEO choisis,
        // puis les orthos IGN par défaut.
        function _pickDefault(configured, ignFallback, index) {
            var item = _findByIdOrLabel(configured);
            if (item) { return item.id; }
            if (_geoLayers.length) { item = _geoLayers[index] || _geoLayers[0]; }
            else { item = _getItem(ignFallback) || _catalogue[index] || _catalogue[0]; }
            return item ? item.id : null;
        }

        // ============================================================
        // Interface « Sur la carte » : bouton MapTools + barre de menus
        // ============================================================
        var _mapToolExt = null;
        var _barEl      = null;
        var _barControl = null;

        function _registerMapTool() {
            _mapToolExt = acfExtensionService.registerMapToolExtension({
                key:              pluginConf.name,
                name:             _toolName,
                icon:             'icon icon_compare',
                content:          '<span class="icon icon_compare" aria-hidden="true"></span>',
                position:         _toolPosition,
                priority:         100,
                disableMobileapp: true,
                handle:           function () { _toggle(); }
            });
            _subscribe(function (s) {
                if (_mapToolExt && _mapToolExt.getButton) {
                    _mapToolExt.getButton().toggleClass('geo-compare-swipe-tool-active', s.active);
                }
            });
        }

        var _barSelects = null;   // menus de la barre sur la carte, à remplir de nouveau quand le catalogue change

        function _refreshMenus() {
            if (_barSelects) {
                _fillSelect(_barSelects.left,  _state.leftId);
                _fillSelect(_barSelects.right, _state.rightId);
            }
        }

        function _fillSelect(select, selectedId) {
            select.innerHTML = '';
            var groups = {}, order = [];
            _catalogue.forEach(function (bm) {
                if (!groups[bm.group]) {
                    var og = document.createElement('optgroup');
                    og.label = bm.group;
                    groups[bm.group] = og;
                    order.push(og);
                }
                var opt = document.createElement('option');
                opt.value = bm.id;
                opt.textContent = bm.label;
                groups[bm.group].appendChild(opt);
            });
            order.forEach(function (og) { select.appendChild(og); });
            select.value = selectedId;
        }

        function _buildMapBar() {
            _barEl = document.createElement('div');
            _barEl.className = 'geo-compare-swipe-bar';
            _barEl.innerHTML = [
                '<div class="geo-compare-swipe-side geo-compare-swipe-side--left">',
                '  <div class="geo-compare-swipe-label geo-compare-swipe-label--left"></div>',
                '  <select class="geo-compare-swipe-select" data-side="left"></select>',
                '</div>',
                '<div class="geo-compare-swipe-center">',
                '  <div class="geo-compare-swipe-modes" role="group">',
                '    <button type="button" class="geo-compare-swipe-btn" data-mode="swipe">Rideau</button>',
                '    <button type="button" class="geo-compare-swipe-btn" data-mode="loupe">Loupe</button>',
                '  </div>',
                '  <button type="button" class="geo-compare-swipe-btn geo-compare-swipe-btn--stop" data-action="stop">',
                '    Arrêter',
                '  </button>',
                '  <div class="geo-compare-swipe-foot">' + changelog.linkHtml() + '</div>',
                '</div>',
                '<div class="geo-compare-swipe-side geo-compare-swipe-side--right">',
                '  <div class="geo-compare-swipe-label geo-compare-swipe-label--right"></div>',
                '  <select class="geo-compare-swipe-select" data-side="right"></select>',
                '</div>'
            ].join('');

            var selLeft  = _barEl.querySelector('[data-side="left"]');
            var selRight = _barEl.querySelector('[data-side="right"]');
            _fillSelect(selLeft,  _state.leftId);
            _fillSelect(selRight, _state.rightId);
            _barSelects = { left: selLeft, right: selRight };

            selLeft.addEventListener('change',  function () { _setLeft(selLeft.value); });
            selRight.addEventListener('change', function () { _setRight(selRight.value); });
            _barEl.addEventListener('click', function (e) {
                var t = e.target;
                if (t.getAttribute('data-mode')) { _setMode(t.getAttribute('data-mode')); }
                if (t.getAttribute('data-action') === 'stop') { _stop(); }
                if (t.closest && t.closest('[data-changelog]')) { changelog.open(); }
            });
            // La barre ne doit pas déclencher les interactions de la carte (clic, glisser, molette).
            ['mousedown', 'pointerdown', 'touchstart', 'wheel', 'dblclick'].forEach(function (ev) {
                _barEl.addEventListener(ev, function (e) { e.stopPropagation(); });
            });

            _subscribe(function (s) {
                selLeft.value  = s.leftId;
                selRight.value = s.rightId;
                var loupe = s.mode === 'loupe';
                _barEl.querySelector('.geo-compare-swipe-label--left').textContent  = loupe ? 'Fond de plan' : 'Raster gauche';
                _barEl.querySelector('.geo-compare-swipe-label--right').textContent = loupe ? 'Dans la loupe' : 'Raster droite';
                Array.prototype.forEach.call(_barEl.querySelectorAll('[data-mode]'), function (b) {
                    b.classList.toggle('geo-compare-swipe-btn--on', b.getAttribute('data-mode') === s.mode);
                });
                if (s.active && !_barControl) {
                    _barControl = new window.ol.control.Control({ element: _barEl });
                    _map.addControl(_barControl);
                } else if (!s.active && _barControl) {
                    _map.removeControl(_barControl);
                    _barControl = null;
                }
                if (s.error) { window.alert('Comparateur de rasters : ' + s.error); }
            });
        }

        // ============================================================
        // Interface « Panneau latéral » : widget natif GEO
        // ============================================================
        // En gabarit pro1, le widget doit rester un rightPanel ; ailleurs, un widget.side.
        var _widgetType = (window.bgCanvasId === 'pro1') ? 'rightPanel' : 'widget.side';

        function _registerWidget() {
            acfExtensionService.registerWidgetExtension({
                type:         _widgetType,
                key:          pluginConf.name,
                extensionKey: pluginConf.name,
                name:         _toolName,
                icon:         'icon icon_compare',
                active:       false,
                widthPolicy:  'custom',
                enable:       function () { return true; },
                template:     _buildTemplate(),
                controller:   _buildController()
            });
        }

        function _buildTemplate() {
            return [
                '<div class="geo-compare-swipe-widget">',
                '  <h3 class="geo-compare-swipe-title">{{ title }}</h3>',
                '  <div class="geo-compare-swipe-field">',
                '    <label>{{ state.mode === \'loupe\' ? \'Fond de plan\' : \'Raster gauche\' }}</label>',
                '    <select class="geo-compare-swipe-select"',
                '            ng-model="sel.left"',
                '            ng-options="b.id as b.label group by b.group for b in catalogue"',
                '            ng-change="setLeft(sel.left)"></select>',
                '  </div>',
                '  <div class="geo-compare-swipe-field">',
                '    <label>{{ state.mode === \'loupe\' ? \'Dans la loupe\' : \'Raster droite\' }}</label>',
                '    <select class="geo-compare-swipe-select"',
                '            ng-model="sel.right"',
                '            ng-options="b.id as b.label group by b.group for b in catalogue"',
                '            ng-change="setRight(sel.right)"></select>',
                '  </div>',
                '  <div class="geo-compare-swipe-modes" role="group">',
                '    <button type="button" class="geo-compare-swipe-btn"',
                '            ng-class="{\'geo-compare-swipe-btn--on\': state.mode === \'swipe\'}"',
                '            ng-click="setMode(\'swipe\')">Rideau</button>',
                '    <button type="button" class="geo-compare-swipe-btn"',
                '            ng-class="{\'geo-compare-swipe-btn--on\': state.mode === \'loupe\'}"',
                '            ng-click="setMode(\'loupe\')">Loupe</button>',
                '  </div>',
                '  <button type="button" class="geo-compare-swipe-btn geo-compare-swipe-btn--main"',
                '          ng-class="{\'geo-compare-swipe-btn--on\': state.active}"',
                '          ng-click="toggle()">{{ state.active ? \'Arrêter la comparaison\' : \'Comparer\' }}</button>',
                '  <div class="geo-compare-swipe-error" ng-if="state.error">{{ state.error }}</div>',
                '  <div class="geo-compare-swipe-foot">' + changelog.linkHtml() + '</div>',
                '</div>'
            ].join('\n');
        }

        function _buildController() {
            return ['$scope', '$element', '$timeout', function ($scope, $element, $timeout) {
                // Lien « Nouveautés » : clic délégué (gabarit en HTML brut) ; point rouge remis à jour à l'ouverture.
                $element[0].addEventListener('click', function (e) {
                    if (e.target.closest && e.target.closest('[data-changelog]')) { changelog.open(); }
                });
                $timeout(function () { changelog.refresh(); });
                _ensureCatalogue();   // menus remplis dès l'ouverture du panneau
                $scope.title     = _toolName;
                $scope.catalogue = _catalogue;
                $scope.state     = _snapshot();
                $scope.sel       = { left: _state.leftId, right: _state.rightId };

                $scope.toggle   = _toggle;
                $scope.setMode  = _setMode;
                $scope.setLeft  = _setLeft;
                $scope.setRight = _setRight;

                var unsubscribe = _subscribe(function (s) {
                    $scope.$evalAsync(function () {
                        $scope.state     = s;
                        $scope.sel.left  = s.leftId;
                        $scope.sel.right = s.rightId;
                    });
                });
                // La comparaison continue de vivre quand le panneau est refermé : seul
                // l'abonnement au scope est libéré.
                $scope.$on('$destroy', unsubscribe);
            }];
        }

        // ============================================================
        // Styles (injectés une seule fois)
        // ============================================================
        function _injectStyles() {
            if (document.getElementById('geo-compare-swipe-styles')) { return; }

            var style = document.createElement('style');
            style.id = 'geo-compare-swipe-styles';
            style.textContent = [
                // Bouton MapTools actif
                'button.geo-compare-swipe-tool-active,button.geo-compare-swipe-tool-active:hover{',
                '  background-color:#74b03e!important;color:#fff!important;}',
                'button.geo-compare-swipe-tool-active .icon{color:#fff!important;}',

                // Contour de la loupe : blanc + liseré sombre, lisible sur ortho claire ou sombre
                '.geo-compare-swipe-ring{position:absolute;box-sizing:content-box;border:3px solid #fff;',
                '  border-radius:50%;pointer-events:none;z-index:5;',
                '  box-shadow:0 0 0 1px rgba(0,0,0,.6),inset 0 0 0 1px rgba(0,0,0,.6),0 0 14px rgba(0,0,0,.45);}',
                '.geo-compare-swipe-ring[hidden]{display:none;}',

                // Boutons
                '.geo-compare-swipe-btn{background:#fff;border:2px solid #74b03e;border-radius:16px;',
                '  color:#74b03e;cursor:pointer;font:700 13px/18px "Open Sans",Helvetica,Arial,sans-serif;',
                '  padding:4px 14px;transition:.2s ease;white-space:nowrap;}',
                '.geo-compare-swipe-btn:hover,.geo-compare-swipe-btn--on{background:#74b03e;color:#fff;}',
                '.geo-compare-swipe-btn--stop{border-color:#c0392b;color:#c0392b;}',
                '.geo-compare-swipe-btn--stop:hover{background:#c0392b;color:#fff;}',
                '.geo-compare-swipe-modes{display:inline-flex;gap:6px;}',
                '.geo-compare-swipe-select{max-width:100%;width:100%;height:32px;border-radius:12px;',
                '  border:1px solid #bbb;padding:2px 8px;background:#fff;color:#333;}',

                // Barre sur la carte
                '.geo-compare-swipe-bar{position:absolute;left:50%;bottom:34px;transform:translateX(-50%);',
                '  width:calc(100% - 24px);max-width:900px;display:flex;flex-wrap:wrap;gap:8px;',
                '  align-items:flex-end;justify-content:center;z-index:6;pointer-events:none;}',
                '.geo-compare-swipe-bar>*{pointer-events:auto;}',
                '.geo-compare-swipe-side{flex:1 1 220px;max-width:280px;background:rgba(255,255,255,.93);',
                '  border-radius:14px;padding:6px 10px;box-shadow:0 1px 6px rgba(0,0,0,.3);}',
                '.geo-compare-swipe-center{display:flex;flex-direction:column;gap:6px;align-items:center;',
                '  background:rgba(255,255,255,.93);border-radius:14px;padding:6px 10px;',
                '  box-shadow:0 1px 6px rgba(0,0,0,.3);}',
                '.geo-compare-swipe-label{font:800 14px/18px "Open Sans",Helvetica,Arial,sans-serif;',
                '  text-align:center;margin-bottom:2px;}',
                '.geo-compare-swipe-label--left{color:#74b03e;}',
                '.geo-compare-swipe-label--right{color:#0356b6;}',

                // Panneau latéral
                '.geo-compare-swipe-widget{padding:14px;display:flex;flex-direction:column;gap:12px;}',
                '.geo-compare-swipe-title{margin:0;font-size:16px;}',
                '.geo-compare-swipe-field label{display:block;font-weight:700;margin-bottom:4px;}',
                '.geo-compare-swipe-btn--main{align-self:flex-start;}',
                '.geo-compare-swipe-error{color:#c0392b;}',
                '.geo-compare-swipe-foot{text-align:right;}'
            ].join('\n');
            document.head.appendChild(style);
        }
    }]);
