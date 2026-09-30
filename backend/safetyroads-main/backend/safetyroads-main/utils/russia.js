// SafetyRoad geographic guard: public road/station data is restricted to the Russian Federation.
// This is a name-level guard used in addition to OSM's RU country boundary queries.
const RU_REGION_RE = /(?:^|[\s,()\-])(?:росси(?:я|и|йский|йская|йское|йские)|рф|российск\w*|москв\w*|санкт[- ]?петербург\w*|ленинградск\w*|московск\w*|калининградск\w*|архангельск\w*|астраханск\w*|белгородск\w*|брянск\w*|владимирск\w*|волгоградск\w*|вологодск\w*|вятск\w*|воронежск\w*|ивановск\w*|иркутск\w*|калужск\w*|кемеровск\w*|кировск\w*|костромск\w*|курганск\w*|курск\w*|ленинградск\w*|липецк\w*|магаданск\w*|мурманск\w*|нижегородск\w*|новгородск\w*|новосибирск\w*|омск\w*|оренбургск\w*|орловск\w*|пензенск\w*|псковск\w*|ростовск\w*|рязанск\w*|самарск\w*|саратовск\w*|сахалинск\w*|свердловск\w*|смоленск\w*|тамбовск\w*|тверск\w*|томск\w*|тульск\w*|тюменск\w*|ульяновск\w*|челябинск\w*|ярославск\w*|алтайск\w*|забайкальск\w*|камчатск\w*|краснодарск\w*|красноярск\w*|пермск\w*|приморск\w*|ставропольск\w*|хабаровск\w*|ханты[- ]?мансийск\w*|чукотск\w*|ямало[- ]?ненецк\w*|адыге\w*|башкортостан\w*|бурят\w*|дагестан\w*|ингушет\w*|кабардино[- ]?балкар\w*|калмык\w*|карачаево[- ]?черкес\w*|карели\w*|коми\w*|крым\w*|луганск\w*|донецк\w*|марий эл|мордов\w*|саха\w*|якут\w*|северная осетия\w*|татарстан\w*|тыва\w*|удмурт\w*|хакас\w*|чечен\w*|чуваш\w*|еврейск\w*|севастопол\w*)/iu;

// Explicit foreign names prevent accidental acceptance when an imported record has
// a foreign region name. The OSM area query remains the authoritative coordinate guard.
const FOREIGN_RE = /(?:finland|suomi|финлянд\w*|estonia|eesti|эстон\w*|latvia|latvija|латви\w*|lithuania|lietuva|литв\w*|norway|norge|норвег\w*|sweden|sverige|швец\w*|belarus|беларус\w*|belarus|белорус\w*|ukraine|украин\w*|kazakhstan|казахстан\w*|georgia|грузин\w*|azerbaijan|азербайджан\w*|armenia|армени\w*|china|кита\w*|mongolia|монголи\w*|japan|япон\w*|north korea|южн|северн.*коре|poland|польш\w*|germany|германи\w*|turkey|турци\w*|usa|united states|сша|alaska|америк\w*)/iu;

function isLikelyRussianRegion(value) {
  const s = String(value || '').trim();
  if (!s) return false;
  if (FOREIGN_RE.test(s)) return false;
  return RU_REGION_RE.test(s);
}

module.exports = { RU_REGION_RE, FOREIGN_RE, isLikelyRussianRegion };
