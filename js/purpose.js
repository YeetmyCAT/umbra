// What an object is for, from its name, owner and orbit. Names in the public catalogue are the main clue; the rules
// are ordered from specific to general. Returns { purpose, operator, cls } where cls drives the shape library.
const R = [
  [/^ISS OBJECT|^ISS DEB/, 'Small satellite released from the ISS (CubeSat deployer)', null, 'cube'],
  [/^ISS \(ZARYA\)$|^ISS$/, 'Crewed space station (International Space Station)', 'NASA / Roscosmos / ESA / JAXA / CSA', 'iss'],
  [/^CSS \(TIANHE|TIANHE/, 'Crewed space station (Tiangong / China Space Station)', 'CMSA', 'css'],
  [/WENTIAN|MENGTIAN/, 'Module of the China Space Station', 'CMSA', 'dockedmodule'],
  [/^HST$|^HUBBLE SPACE TELESCOPE$/, 'Space telescope (Hubble, visible/UV/near-IR astronomy)', 'NASA / ESA', 'hst'],
  [/^STARLINK/, 'Communications: SpaceX Starlink broadband internet constellation', 'SpaceX', 'starlink'],
  [/^STARSHIELD/, 'Military communications/remote sensing (SpaceX Starshield)', 'SpaceX / US government', 'starlink'],
  [/^ONEWEB/, 'Communications: OneWeb (Eutelsat) broadband constellation', 'Eutelsat OneWeb', 'oneweb'],
  [/^KUIPER/, 'Communications: Amazon Project Kuiper broadband constellation', 'Amazon', 'kuiper'],
  [/^QIANFAN|^G60|^SPACESAIL/, 'Communications: Qianfan (Thousand Sails) broadband constellation', 'Shanghai Spacecom', 'qianfan'],
  [/^GUOWANG|^SATNET/, 'Communications: Guowang national broadband constellation', 'China SatNet', 'qianfan'],
  [/^IRIDIUM [0-9]{3}|^IRIDIUM.*NEXT/, 'Communications: Iridium NEXT mobile satellite phone/data network', 'Iridium', 'iridiumnext'],
  [/^IRIDIUM/, 'Communications: Iridium (first generation, retired; tumbling)', 'Iridium', 'iridium1'],
  [/^GLOBALSTAR/, 'Communications: Globalstar mobile phone/data', 'Globalstar', 'leocomm'],
  [/^ORBCOMM/, 'Communications: ORBCOMM machine-to-machine / ship tracking (AIS)', 'ORBCOMM', 'leocomm'],
  [/^O3B/, 'Communications: SES O3b medium-Earth-orbit broadband', 'SES', 'leocomm'],
  [/^AST SPACEMOBILE|^BLUEBIRD|^BLUEWALKER/, 'Communications: AST SpaceMobile direct-to-phone broadband (huge phased array)', 'AST SpaceMobile', 'bluebird'],
  [/^NAVSTAR|^GPS /, 'Navigation: US Global Positioning System (GPS)', 'US Space Force', 'gps'],
  [/GLONASS/, 'Navigation: Russian GLONASS', 'Roscosmos', 'glonass'],
  [/^GSAT0|^GALILEO/, 'Navigation: European Galileo', 'EU / ESA', 'galileo'],
  [/^BEIDOU/, 'Navigation: Chinese BeiDou', 'CNSA / CSNO', 'beidou'],
  [/^IRNSS|^NVS/, 'Navigation: Indian NavIC', 'ISRO', 'geo'],
  [/^QZS/, 'Navigation: Japanese Quasi-Zenith Satellite System', 'JAXA / Cabinet Office', 'geo'],
  [/^TDRS/, 'Data relay: NASA Tracking and Data Relay Satellite', 'NASA', 'geo'],
  [/^(GOES|HIMAWARI|METEOSAT|MTG|ELEKTRO|INSAT-3D|GEO-KOMPSAT-2A|FENGYUN 4)/, 'Weather: geostationary meteorological imaging', null, 'geo'],
  [/^(NOAA|METOP|METEOR-M|FENGYUN 3|DMSP|SUOMI NPP|JPSS|NOAA 2[01]|EWS)/, 'Weather: polar-orbiting meteorological satellite', null, 'eo'],
  [/^(LANDSAT|SENTINEL|WORLDVIEW|PLEIADES|SPOT|GAOFEN|ZIYUAN|CBERS|RESURS|KOMPSAT|CARTOSAT|RESOURCESAT|SKYSAT|JILIN|SUPERVIEW|PNEO|KANOPUS|DEIMOS|GEOEYE|TERRA|AQUA|AURA|OCO|SMAP|GRACE|CRYOSAT|SWOT|ICESAT|PROBA|THEOS|NUSAT|NEWSAT|HYPSO|ALOS|EARTHCARE|AEOLUS|BIOMASS|NISAR|PACE)/, 'Earth observation: imaging / environmental monitoring', null, 'eo'],
  [/^(FLOCK|DOVE|SUPERDOVE)/, 'Earth observation: Planet Labs Dove imaging CubeSat', 'Planet', 'cube3'],
  [/^LEMUR/, 'Weather (GPS radio occultation) and ship/aircraft tracking: Spire Lemur CubeSat', 'Spire Global', 'cube3'],
  [/^(ICEYE|CAPELLA|UMBRA|RADARSAT|TERRASAR|TANDEM-X|COSMO-SKYMED|CSG|SAOCOM|PAZ|NOVASAR|STRIX|QPS-SAR|SENTINEL-1)/, 'Earth observation: synthetic-aperture radar imaging', null, 'sar'],
  [/^YAOGAN|^JIANBING|^TJS|^SHIYAN/, 'Military/government (Chinese reconnaissance or technology test)', 'PRC', 'eo'],
  [/^USA |^NROL|^LACROSSE|^ONYX/, 'Military/government (US national security payload; purpose not published)', 'US government', 'eo'],
  [/^(OFEQ|SAR-LUPE|CSO|HELIOS|IGS|KOSMOS|COSMOS)/, 'Military/government payload (purpose not published)', null, 'eo'],
  [/^HULIANWANG|^HLWJS/, 'Communications: Chinese national satellite internet (Guowang) test/production satellite', 'China SatNet', 'qianfan'],
  [/^(OPS|USA)\b/, 'Military/government (US national security payload; purpose not published)', 'US government', 'eo'],
  [/^(GEESAT|TIANQI|KINEIS|CENTISPACE|SITRO-AIS|CONNECTA|BRO|YAM|ASTROCAST|TEVEL|FOSSASAT|SATELIOT|APRIZESAT|NORSAT|LEMUR|SPACEBEE|HAWK|SKYKRAFT|ESSAIM|LYNK|PELICAN|TOMORROW|KSM|CUBY|GHGSAT|HORS)/, 'Small satellite constellation (IoT, AIS ship tracking, RF geolocation or Earth sensing)', null, 'cube'],
  [/^(PRAETORIAN|SDA[_-]|STARSHIELD)/, 'Military: US Space Development Agency tracking/transport layer', 'US Space Development Agency', 'eo'],
  [/^(METEOR|FORMOSAT|HAIYANG|NADEZHDA|TIROS|ESSA|NIMBUS|OKEAN|FENGYUN|YUNHAI|YUNYAO|TIANMU|NINGXIA|PIESAT|GRUS|ALSAT|ARIRANG|IRS|RISAT|HJ|ZHUHAI|RAPIDEYE|NEONSAT|AIST|FOREST|WILDFIRE|TIANHUI|IRIDE|CHUANGXIN|SAUDISAT|KORSAT|LKW|SOLRAD|GNOMES|HERMES)/, 'Earth observation / weather / environmental monitoring', null, 'eo'],
  [/^(GONETS|RASSVET|SCS|SAUDICOMSAT|STRELA|PARUS|TSIKADA|MOLNIYA|RADIO|OSCAR|UOSAT|TRANSIT|SECOR|TIANPING|BANDWAGON|TRANSPORTER|ION SCV|AETHER|GLOBAL|CHECKMATE|KIKU|PULSAR|NETSAT|CENTAURI|SPACEMOBILE)/, 'Communications, navigation-test or rideshare/space-tug payload', null, 'eo'],
  [/^(AEROCUBE|PICOSAT|CANX|UWE|UNISAT|CAS|GEOSCAN|CUBE|STARLING|GJZ)/, 'Small CubeSat (research/technology/education)', null, 'cube'],
  [/^(EXPLORER|OV|MIDAS|GGSE|SJ|SHIJIAN|AE|HEAD|LEGION|NOVA|RUBIN|R)\b/, 'Science / technology / government test payload', null, 'eo'],
  [/^(CREW DRAGON|DRAGON|CRS)/, 'Crew/cargo spacecraft (SpaceX Dragon)', 'SpaceX', 'dragon'],
  [/^(SOYUZ)/, 'Crewed spacecraft (Soyuz)', 'Roscosmos', 'soyuz'],
  [/^PROGRESS/, 'Cargo spacecraft (Progress)', 'Roscosmos', 'soyuz'],
  [/^CYGNUS/, 'Cargo spacecraft (Cygnus)', 'Northrop Grumman', 'cygnus'],
  [/^SHENZHOU/, 'Crewed spacecraft (Shenzhou)', 'CMSA', 'soyuz'],
  [/^TIANZHOU/, 'Cargo spacecraft (Tianzhou)', 'CMSA', 'tianzhou'],
  [/^(HTV|KOUNOTORI)/, 'Cargo spacecraft (HTV)', 'JAXA', 'cygnus'],
  [/^(INTELSAT|SES|EUTELSAT|ASTRA|VIASAT|ECHOSTAR|DIRECTV|SIRIUS|XM-|TELSTAR|ANIK|AMAZONAS|HISPASAT|ARABSAT|NILESAT|TURKSAT|YAMAL|EXPRESS|CHINASAT|ZHONGXING|APSTAR|ASIASAT|JCSAT|SUPERBIRD|BSAT|KOREASAT|THAICOM|MEASAT|OPTUS|INMARSAT|THURAYA|SKYTERRA|TERRESTAR|GALAXY|AMC|NSS|HYLAS|YAHSAT|AL YAH|EUTELSAT|KA-SAT|JUPITER|ECHO|SPACEWAY|MUOS|WGS|AEHF|MILSTAR|SKYNET|SYRACUSE|GSAT|INSAT|TIANLIAN|TIANTONG|SHIJIAN)/, 'Communications: geostationary communications/broadcast satellite', null, 'geo'],
  [/CUBESAT|^CUBE/, 'Small CubeSat (research/technology/education)', null, 'cube'],
  [/^(SWIFT|FERMI|NUSTAR|TESS|AGILE|XMM|INTEGRAL|IXPE|NICER|HXMT|EINSTEIN PROBE|SVOM|XRISM|CHEOPS|ASTROSAT|SPEKTR)/, 'Science: space astronomy observatory', null, 'science'],
  [/^(VAN ALLEN|MMS|THEMIS|CLUSTER|ARASE|SWARM|DEMETER|CSES|TIMED|ICON|GOLD|TRACERS)/, 'Science: space physics / magnetosphere / upper atmosphere', null, 'science'],
  [/^(LAGEOS|AJISAI|STARLETTE|STELLA|LARES|ETALON|BLITS|LARETS)/, 'Geodesy: passive laser-ranging reflector sphere', null, 'sphere'],
  [/^CALSPHERE/, 'Radar calibration sphere', null, 'sphere'],
  [/^ENVISAT/, 'Earth observation (ESA Envisat, dead since 2012)', 'ESA', 'envisat'],
];
export const STATUS = { '+': 'Operational', '-': 'Not operational', P: 'Partially operational', B: 'Backup / standby', S: 'Spare', X: 'Extended mission', D: 'Decayed', '?': 'Status unknown', '': '' };
export const TYPES = ['Payload', 'Rocket body', 'Debris', 'Unknown object'];
export function classify(o) {
  const name = o.name || '';
  if (o.type === 1) return { purpose: 'Spent rocket stage (no function)', cls: 'rb' };
  if (o.type === 2) return { purpose: 'Debris (fragment or mission-related object)', cls: 'debris' };
  for (const [re, p, op, cls] of R) if (re.test(name)) {
    // COSMOS covers both GLONASS and military; split by orbit (GLONASS: ~2.13 rev/day, 64.8 deg)
    if (cls === 'eo' && /^(KOSMOS|COSMOS)/.test(name) && Math.abs(o.n - 2.13) < 0.05) return { purpose: 'Navigation: Russian GLONASS', operator: 'Roscosmos', cls: 'glonass' };
    if (cls === 'eo' && o.n > 0.9 && o.n < 1.1) return { purpose: p, operator: op, cls: 'geo' };
    return { purpose: p, operator: op, cls };
  }
  if (o.type === 3) return { purpose: 'Unidentified object (not yet catalogued as payload or debris)', cls: o.n > 0.9 && o.n < 1.1 ? 'geo' : 'unknown' };
  if (/^OBJECT [A-Z]+$|^20[0-9]{2}-[0-9]{3}/.test(name)) return { purpose: 'Recently launched object (not yet identified)', cls: 'unknown' };
  if (o.n > 0.9 && o.n < 1.1) return { purpose: 'Geosynchronous payload (most are communications, weather or military)', cls: 'geo' };
  if (o.n > 1.8 && o.n < 2.3) return { purpose: 'Payload in a navigation-type medium Earth orbit', cls: 'eo' };
  return { purpose: 'Payload (purpose not published)', cls: 'payload' };
}
// Orbit regime from mean motion and eccentricity
export function regime(o) {
  const a = Math.cbrt(398600.4418 / Math.pow(o.n * 2 * Math.PI / 86400, 2)), hp = a * (1 - o.e) - 6378, ha = a * (1 + o.e) - 6378;
  if (o.e > 0.25 && ha > 20000) return { name: ha > 30000 && o.i > 50 && o.i < 70 && o.n > 1.9 && o.n < 2.1 ? 'Molniya (HEO)' : 'Highly elliptical (HEO)', hp, ha, a };
  if (o.n > 0.95 && o.n < 1.05 && o.e < 0.05) return { name: o.i < 2 ? 'Geostationary (GEO)' : 'Geosynchronous (GSO)', hp, ha, a };
  if (ha > 36500) return { name: 'High Earth orbit (HEO)', hp, ha, a };
  if (hp > 2000) return { name: Math.abs(o.n - 2.006) < 0.03 ? 'Medium Earth orbit (MEO, GPS-type semi-synchronous)' : 'Medium Earth orbit (MEO)', hp, ha, a };
  return { name: 'Low Earth orbit (LEO)', hp, ha, a };
}
