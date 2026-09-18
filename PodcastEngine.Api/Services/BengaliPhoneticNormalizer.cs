using System;
using System.Collections.Generic;
using System.Text;
using System.Text.RegularExpressions;

namespace PodcastEngine.Api.Services
{
    public static class BengaliPhoneticNormalizer
    {
        private static readonly Dictionary<int, string> DigitTwoMap = new()
        {
            { 0, "শূন্য" }, { 1, "এক" }, { 2, "দুই" }, { 3, "তিন" }, { 4, "চার" },
            { 5, "পাঁচ" }, { 6, "ছয়" }, { 7, "সাত" }, { 8, "আট" }, { 9, "নয়" },
            { 10, "দশ" }, { 11, "এগারো" }, { 12, "বারো" }, { 13, "তেরো" }, { 14, "চোদ্দ" },
            { 15, "পনেরো" }, { 16, "ষোলো" }, { 17, "সতেরো" }, { 18, "আঠারো" }, { 19, "উনিশ" },
            { 20, "কুড়ি" }, { 21, "একুশ" }, { 22, "বাইশ" }, { 23, "তেইশ" }, { 24, "চব্বিশ" },
            { 25, "পঁচিশ" }, { 26, "ছাব্বিশ" }, { 27, "সাতাশ" }, { 28, "আঠাশ" }, { 29, "উনত্রিশ" },
            { 30, "ত্রিশ" }, { 31, "একত্রিশ" }, { 32, "বত্রিশ" }, { 33, "তেত্রিশ" }, { 34, "চৌত্রিশ" },
            { 35, "পঁয়ত্রিশ" }, { 36, "ছত্রিশ" }, { 37, "সাঁইত্রিশ" }, { 38, "আটত্রিশ" }, { 39, "উনচল্লিশ" },
            { 40, "চল্লিশ" }, { 41, "একচল্লিশ" }, { 42, "বিয়াল্লিশ" }, { 43, "তেতাল্লিশ" }, { 44, "চুয়াল্লিশ" },
            { 45, "পঁয়তাল্লিশ" }, { 46, "ছেচল্লিশ" }, { 47, "সাতচল্লিশ" }, { 48, "আটচল্লিশ" }, { 49, "উনপঞ্চাশ" },
            { 50, "পঞ্চাশ" }, { 51, "একান্ন" }, { 52, "বায়ান্ন" }, { 53, "তিপ্পান্ন" }, { 54, "চুয়ান্ন" },
            { 55, "পঞ্চান্ন" }, { 56, "ছাপ্পান্ন" }, { 57, "সাতান্ন" }, { 58, "আটান্ন" }, { 59, "উনষাট" },
            { 60, "ষাট" }, { 61, "একষট্টি" }, { 62, "বাষট্টি" }, { 63, "তেষট্টি" }, { 64, "চৌষট্টি" },
            { 65, "পঁয়ষট্টি" }, { 66, "ছেষট্টি" }, { 67, "সাতষট্টি" }, { 68, "আটষট্টি" }, { 69, "উনসত্তর" },
            { 70, "সত্তর" }, { 71, "একাত্তর" }, { 72, "বাহাত্তর" }, { 73, "তিয়াত্তর" }, { 74, "চুয়াত্তর" },
            { 75, "পঁচাত্তর" }, { 76, "ছিয়াত্তর" }, { 77, "সাতাত্তর" }, { 78, "আটাত্তর" }, { 79, "উনাশি" },
            { 80, "আশি" }, { 81, "একাশি" }, { 82, "বিরাশি" }, { 83, "তিরাশি" }, { 84, "চৌরাশি" },
            { 85, "পঁচাশি" }, { 86, "ছিয়াশি" }, { 87, "সাতাশি" }, { 88, "অষ্টআশি" }, { 89, "উননব্বই" },
            { 90, "নব্বই" }, { 91, "একানব্বই" }, { 92, "বিরানব্বই" }, { 93, "তিরানব্বই" }, { 94, "চুরানব্বই" },
            { 95, "পঁচানব্বই" }, { 96, "ছিয়ানব্বই" }, { 97, "সাতানব্বই" }, { 98, "আটানব্বই" }, { 99, "নিরানব্বই" }
        };

        private static readonly Dictionary<string, string> DayMap = new()
        {
            { "1", "পয়লা" }, { "০১", "পয়লা" }, { "১", "পয়লা" },
            { "2", "দোসরা" }, { "০২", "দোসরা" }, { "২", "দোসরা" },
            { "3", "তেসরা" }, { "০৩", "তেসরা" }, { "৩", "তেসরা" },
            { "4", "চৌঠা" }, { "০৪", "চৌঠা" }, { "৪", "চৌঠা" },
            { "5", "পাঁচই" }, { "০৫", "পাঁচই" }, { "৫", "পাঁচই" },
            { "6", "ছয়ই" }, { "০৬", "ছয়ই" }, { "৬", "ছয়ই" },
            { "7", "সাতই" }, { "০৭", "সাতই" }, { "৭", "সাতই" },
            { "8", "আটই" }, { "০৮", "আটই" }, { "৮", "আটই" },
            { "9", "নয়ই" }, { "০৯", "নয়ই" }, { "৯", "নয়ই" },
            { "10", "দশই" }, { "১০", "দশই" },
            { "11", "এগারোই" }, { "১১", "এগারোই" },
            { "12", "বারোই" }, { "১২", "বারোই" },
            { "13", "তেরোই" }, { "১৩", "তেরোই" },
            { "14", "চোদ্দোই" }, { "১৪", "চোদ্দোই" },
            { "15", "পনেরোই" }, { "১৫", "পনেরোই" },
            { "16", "ষোলোই" }, { "১৬", "ষোলোই" },
            { "17", "সতেরোই" }, { "১৭", "সতেরোই" },
            { "18", "আঠারোই" }, { "১৮", "আঠারোই" },
            { "19", "উনিশে" }, { "১৯", "উনিশে" },
            { "20", "বিশে" }, { "২০", "বিশে" },
            { "21", "একুশে" }, { "২১", "একুশে" },
            { "22", "বাইশে" }, { "২২", "বাইশে" },
            { "23", "তেইশে" }, { "২৩", "তেইশে" },
            { "24", "চব্বিশে" }, { "২৪", "চব্বিশে" },
            { "25", "পঁচিশে" }, { "২৫", "পঁচিশে" },
            { "26", "ছাব্বিশে" }, { "২৬", "ছাব্বিশে" },
            { "27", "সাতাশে" }, { "২৭", "সাতাশে" },
            { "28", "আঠাশে" }, { "২৮", "আঠাশে" },
            { "29", "উনত্রিশে" }, { "২৯", "উনত্রিশে" },
            { "30", "ত্রিশে" }, { "৩০", "ত্রিশে" },
            { "31", "একত্রিশে" }, { "৩১", "একত্রিশে" }
        };

        private static readonly Dictionary<string, string> MonthMap = new(StringComparer.OrdinalIgnoreCase)
        {
            { "january", "জানুয়ারি" }, { "jan", "জানুয়ারি" }, { "জানুয়ারি", "জানুয়ারি" },
            { "february", "ফেব্রুয়ারি" }, { "feb", "ফেব্রুয়ারি" }, { "ফেব্রুয়ারি", "ফেব্রুয়ারি" },
            { "march", "মার্চ" }, { "mar", "মার্চ" }, { "মার্চ", "মার্চ" },
            { "april", "এপ্রিল" }, { "apr", "এপ্রিল" }, { "এপ্রিল", "এপ্রিল" },
            { "may", "মে" }, { "মে", "মে" },
            { "june", "জুন" }, { "jun", "জুন" }, { "জুন", "জুন" },
            { "july", "জুলাই" }, { "jul", "জুলাই" }, { "জুলাই", "জুলাই" },
            { "august", "আগস্ট" }, { "aug", "আগস্ট" }, { "আগস্ট", "আগস্ট" },
            { "september", "সেপ্টেম্বর" }, { "sep", "সেপ্টেম্বর" }, { "সেপ্টেম্বর", "সেপ্টেম্বর" },
            { "october", "অক্টোবর" }, { "oct", "অক্টোবর" }, { "অক্টোবর", "অক্টোবর" },
            { "november", "নভেম্বর" }, { "nov", "নভেম্বর" }, { "নভেম্বর", "নভেম্বর" },
            { "december", "ডিসেম্বর" }, { "dec", "ডিসেম্বর" }, { "ডিসেম্বর", "ডিসেম্বর" }
        };

        public static string ConvertBengaliDigitsToEnglish(string input)
        {
            var sb = new StringBuilder();
            foreach (char c in input)
            {
                if (c >= '০' && c <= '৯') sb.Append((char)('0' + (c - '০')));
                else sb.Append(c);
            }
            return sb.ToString();
        }

        public static string Normalize(string text)
        {
            if (string.IsNullOrWhiteSpace(text)) return text;

            // 1. Calendar Dates normalization
            text = Regex.Replace(text, @"(?<![\d\u09E6-\u09EF])([0-9]{1,2}|[০-৯]{1,2})\s*(January|February|March|April|May|June|July|August|September|October|November|December|জানুয়ারি|ফেব্রুয়ারি|মার্চ|এপ্রিল|মে|জুন|জুলাই|আগস্ট|সেপ্টেম্বর|অক্টোবর|নভেম্বর|ডিসেম্বর)\b", m =>
            {
                string dayRaw = m.Groups[1].Value;
                string monthRaw = m.Groups[2].Value;
                string dayWords = DayMap.TryGetValue(dayRaw, out var d) ? d : dayRaw;
                string monthWords = MonthMap.TryGetValue(monthRaw, out var mon) ? mon : monthRaw;
                return dayWords + " " + monthWords;
            }, RegexOptions.IgnoreCase);

            // 2. 4-Digit Years normalization
            text = Regex.Replace(text, @"(?<![\d\u09E6-\u09EF])([12][09][0-9]{2}|[১২][০৯][০-৯]{2})(?![\d\u09E6-\u09EF])", m =>
            {
                string raw = ConvertBengaliDigitsToEnglish(m.Value);
                if (int.TryParse(raw, out int yr))
                {
                    if (yr >= 1900 && yr <= 1999)
                    {
                        int rem = yr - 1900;
                        if (rem == 0) return "উনিশশো";
                        if (rem < 100 && DigitTwoMap.TryGetValue(rem, out string? val)) return "উনিশশো " + val;
                    }
                    else if (yr >= 2000 && yr <= 2099)
                    {
                        int rem = yr - 2000;
                        if (rem == 0) return "দুই হাজার";
                        if (rem < 100 && DigitTwoMap.TryGetValue(rem, out string? val)) return "দু'হাজার " + val;
                    }
                }
                return m.Value;
            });

            // 3. Shaal Pronunciation Fix (সাল -> শাল, সালে -> শালে, সালের -> শালের for true Shh sound)
            text = Regex.Replace(text, @"\bসালের\b", "শালের");
            text = Regex.Replace(text, @"\bসালে\b", "শালে");
            text = Regex.Replace(text, @"\bসাল\b", "শাল");

            // 4. Decades normalization
            text = Regex.Replace(text, @"(?i)late\s*40s\s*(?:আর|and)\s*early\s*50s(?:\s*এর\s*সময়ে)?", "চল্লিশের দশকের শেষ আর পঞ্চাশের দশকের শুরুর দিকে");
            text = Regex.Replace(text, @"(?i)\blate\s*(?:40s|৪০s|৪০-এর|40-এর)(?:\s*দশকে)?\b", "চল্লিশের দশকের শেষের দিকে");
            text = Regex.Replace(text, @"(?i)\bearly\s*(?:50s|৫০s|৫০-এর|50-এর)(?:\s*দশকে)?\b", "পঞ্চাশের দশকের শুরুতে");
            text = Regex.Replace(text, @"(?i)\b(?:70s|৭০s|৭০-এর|70-এর)\s*(?:এর\s*)?(?:দশক|দশকে)?\b", "সত্তরের দশকে");

            // 5. Score & Number expressions
            text = Regex.Replace(text, @"\b৫-০\b|\b5-0\b", "পাঁচ শূন্য");
            text = Regex.Replace(text, @"\b১-০\b|\b1-0\b", "এক শূন্য");
            text = Regex.Replace(text, @"\b(৯০|90)\s*মিনিট", "নব্বই মিনিট");
            text = Regex.Replace(text, @"\b(৮০|80)\s*টাকা", "আশি টাকা");

            // 6. Verb morphology & colloquial corrections
            text = Regex.Replace(text, @"\bবেরোল\b", "বেরিয়ে এলো");
            text = Regex.Replace(text, @"\bলিখল\b|\bলিখলো\b", "লিখে নিলো");
            text = Regex.Replace(text, @"\bবড়\b", "বড়ো");
            text = Regex.Replace(text, @"\bবলব\b", "বলবো");
            text = Regex.Replace(text, @"\bকরব\b", "করবো");
            text = Regex.Replace(text, @"\bযাব\b", "যাবো");
            text = Regex.Replace(text, @"\bহব\b", "হবো");
            text = Regex.Replace(text, @"\bদেখব\b", "দেখবো");
            text = Regex.Replace(text, @"\bজানাব\b", "জানাবো");
            text = Regex.Replace(text, @"\bশুনব\b", "শুনবো");
            text = Regex.Replace(text, @"\bখেলব\b", "খেলবো");
            text = Regex.Replace(text, @"\bএল\b", "এলো");
            text = Regex.Replace(text, @"\bনিল\b", "নিলো");
            text = Regex.Replace(text, @"\bদিল\b", "দিলো");
            text = Regex.Replace(text, @"\bচলল\b", "চললো");
            text = Regex.Replace(text, @"\bপেল\b", "পেলো");
            text = Regex.Replace(text, @"\bবলল\b", "বললো");
            text = Regex.Replace(text, @"\bকরল\b", "করলো");
            text = Regex.Replace(text, @"\bছাড়ল\b", "ছাড়লো");

            // 7. Proper Nouns, Foreign Geography, Trophies & Acronyms
            text = Regex.Replace(text, @"(?i)\bIranian\b", "ইরানিয়ান");
            text = Regex.Replace(text, @"(?i)\bIran\s*এর\b", "ইরানের");
            text = Regex.Replace(text, @"(?i)\bIran\b", "ইরান");
            text = Regex.Replace(text, @"(?i)\bOpponent\b", "প্রতিপক্ষ");
            text = Regex.Replace(text, @"(?i)\bgoalkeeper\b", "গোলকিপার");
            text = Regex.Replace(text, @"(?i)\bWhiteaway,?\s*Laidlaw\s*(?:and|&)\s*Co\.?\b", "হোয়াইটওয়ে, লেডল অ্যান্ড কোং");
            text = Regex.Replace(text, @"(?i)\bCalcutta\s*Football\s*Club\b", "ক্যালকাটা ফুটবল ক্লাব");
            text = Regex.Replace(text, @"(?i)\bCalcutta\s*Football\s*League\b", "ক্যালকাটা ফুটবল লিগ");
            text = Regex.Replace(text, @"(?i)\bCFC\b|\bC\.F\.C\.\b", "সিএফসি");
            text = Regex.Replace(text, @"(?i)\bFC\b|\bF\.C\.\b", "এফসি");
            text = Regex.Replace(text, @"(?i)\bEast\s*Bengal\s*Club\b", "ইস্টবেঙ্গল ক্লাব");
            text = Regex.Replace(text, @"(?i)\bEast\s*Bengal\b", "ইস্টবেঙ্গল");
            text = Regex.Replace(text, @"(?i)\bMohun\s*Bagan\b", "মোহনবাগান");
            text = Regex.Replace(text, @"(?i)\bJorabagan\b", "জোড়াবাগান");
            text = Regex.Replace(text, @"(?i)\bCooch\s*Behar\s*Cup\b", "কোচবিহার কাপ");
            text = Regex.Replace(text, @"(?i)\bCooch\s*Behar\b", "কোচবিহার");
            text = Regex.Replace(text, @"(?i)\bHercules\s*Cup\b", "হারকিউলিস কাপ");
            text = Regex.Replace(text, @"(?i)\bIFA\s*Shield\b", "আইএফএ শিল্ড");
            text = Regex.Replace(text, @"(?i)\bDurand\s*Cup\b", "ডুরান্ড কাপ");
            text = Regex.Replace(text, @"(?i)\bRovers\s*Cup\b", "রোভার্স কাপ");
            text = Regex.Replace(text, @"(?i)\bPAS\s*Club\b", "পাস ক্লাব");
            text = Regex.Replace(text, @"(?i)\bASEAN\s*Club\s*Championship\b", "আশিয়ান ক্লাব চ্যাম্পিয়নশিপ");
            text = Regex.Replace(text, @"(?i)\bASEAN\b", "আশিয়ান");
            text = Regex.Replace(text, @"(?i)\bEden\s*Gardens\b", "ইডেন গার্ডেনস");
            text = Regex.Replace(text, @"(?i)\bJakarta\b", "জাকার্তা");
            text = Regex.Replace(text, @"(?i)\bDerby\b", "ডার্বি");
            text = Regex.Replace(text, @"(?i)\bBiryani\b", "বিরিয়ানি");
            text = Regex.Replace(text, @"(?i)\bSatyagraha\s*movement\b", "সত্যাগ্রহ মুভমেন্ট");

            // Legendary Pancha Pandav names
            text = Regex.Replace(text, @"(?i)\bP\.\s*Venkatesh\b", "পি ভেঙ্কটেশ");
            text = Regex.Replace(text, @"(?i)\bSaleh\b", "সালেহ্");
            text = Regex.Replace(text, @"(?i)\bAppa\s*Rao\b", "আপ্পা রাও");

            // Suffix and compound inflections
            text = Regex.Replace(text, @"(?i)\bfirst\s*half\s*এ\b", "ফার্স্ট হাফে");
            text = Regex.Replace(text, @"(?i)\bfirst\s*division\s*এ\b", "ফার্স্ট ডিভিশনে");
            text = Regex.Replace(text, @"(?i)\bsecond\s*division\s*এ\b", "সেকেন্ড ডিভিশনে");
            text = Regex.Replace(text, @"(?i)\bsecond\s*division\b", "সেকেন্ড ডিভিশন");
            text = Regex.Replace(text, @"(?i)\bcinema\s*এর\b|\bcinemar\b|\bcinema-র\b", "সিনেমার");
            text = Regex.Replace(text, @"(?i)\bclub\s*এর\b", "ক্লাবের");
            text = Regex.Replace(text, @"(?i)\bteam\s*এর\b", "টিমের");
            text = Regex.Replace(text, @"(?i)\bplayers\s*দের\b", "প্লেয়ারদের");
            text = Regex.Replace(text, @"(?i)\bsemi-final\s*এর\b|\bsemi final\s*এর\b", "সেমিফাইনালের");
            text = Regex.Replace(text, @"(?i)\bsemi-final\b|\bsemi final\b", "সেমিফাইনাল");
            text = Regex.Replace(text, @"(?i)\bjersey\s*এর\b", "জার্সির");
            text = Regex.Replace(text, @"(?i)\bepisode\s*এ\b", "এপিসোডে");
            text = Regex.Replace(text, @"(?i)\bsection\s*এ\b", "সেকশনে");
            text = Regex.Replace(text, @"(?i)\bbullet\s*shot\b", "বুলেট শট");
            text = Regex.Replace(text, @"\bvs\b|\bvs\.\b", "বনাম", RegexOptions.IgnoreCase);
            text = text.Replace("&", " and ");

            // 8. CR-017 Narrative Dramatic Gapping (Pre-Date & Pre-Climax Hesitation)
            text = Regex.Replace(text, @"(?<![\,\.\!\?\:\;—–\s])\s+(উনিশশো|দু'হাজার|শাল\s+উনিশশো|শাল\s+দু'হাজার)", ", $1");
            text = Regex.Replace(text, @"(?<![\,\.\!\?\:\;—–\s])\s+(কিন্তু|তবে)\b", ", $1");
            text = Regex.Replace(text, @"(?<![\,\.\!\?\:\;—–\s])\s+(ঠিক\s+সেই\s+সময়ে|হঠাৎ\s+করে|অবশেষে)\b", ", $1,");
            text = Regex.Replace(text, @"(?<![\,\.\!\?\:\;—–\s])\s+(ইতিহাস\s+তৈরি\s+হলো|ইতিহাস\s+তৈরি\s+করলো)", ", $1");
            text = Regex.Replace(text, @",\s*,+", ", ");

            return text;
        }
    }
}