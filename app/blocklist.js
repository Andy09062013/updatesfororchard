// Orchard's built-in ad + tracker blocklist (domains and everything under them).
// Blocking these stops a lot of extra scripts from loading, which saves CPU and battery.
module.exports = [
  // ad networks + exchanges
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'adservice.google.com', 'pagead2.googlesyndication.com',
  'googletagservices.com', 'adnxs.com', 'adnxs-simple.com', 'ads.yahoo.com', 'advertising.com', 'taboola.com', 'outbrain.com',
  'criteo.com', 'criteo.net', 'amazon-adsystem.com', 'zedo.com', 'popads.net', 'popcash.net', 'propellerads.com', 'adsrvr.org',
  'moatads.com', 'pubmatic.com', 'rubiconproject.com', 'openx.net', 'adcolony.com', 'smartadserver.com', 'yieldmo.com', 'media.net',
  'exoclick.com', 'casalemedia.com', 'indexww.com', 'contextweb.com', 'sharethrough.com', 'triplelift.com', '3lift.com', 'gumgum.com',
  'teads.tv', 'spotxchange.com', 'spotx.tv', 'smaato.net', 'inmobi.com', 'mopub.com', 'applovin.com', 'unityads.unity3d.com',
  'adform.net', 'adition.com', 'adtech.de', 'adtechus.com', 'bidswitch.net', 'districtm.io', 'emxdgt.com', 'lijit.com', 'sovrn.com',
  'yieldlab.net', 'adhigh.net', 'adkernel.com', 'admixer.net', 'adroll.com', 'adzerk.net', 'bidr.io', 'servedby-buysellads.com',
  'buysellads.com', 'carbonads.net', 'revcontent.com', 'mgid.com', 'zergnet.com', 'content.ad', 'nativo.com', 'plista.com',
  'ligatus.com', 'yahoo-ads.com', 'gemini.yahoo.com', 'serving-sys.com', 'sizmek.com', 'flashtalking.com', 'innovid.com',
  'tremorhub.com', 'undertone.com', 'conversantmedia.com', 'mathtag.com', 'turn.com', 'tapad.com', 'adgrx.com', 'adsafeprotected.com',
  'doubleverify.com', 'adlightning.com', 'confiant-integrations.net', 'onetag-sys.com', 'richaudience.com', 'improvedigital.com',
  '360yield.com', 'adscale.de', 'stickyadstv.com', 'freewheel.tv', 'fwmrm.net', 'yieldoptimizer.com', 'adsymptotic.com',
  'trafficjunky.net', 'trafficjunky.com', 'juicyads.com', 'adcash.com', 'hilltopads.net', 'clickadu.com', 'adsterra.com',
  'popmyads.com', 'onclickads.net', 'adskeeper.co.uk', 'adskeeper.com', 'admaven.com', 'ad-maven.com', 'richpush.co',
  'pushame.com', 'pushwhy.com', 'galaksion.com', 'evadav.com', 'monetag.com', 'a-ads.com', 'coinzilla.com',
  // trackers + analytics beacons
  'scorecardresearch.com', 'quantserve.com', 'quantcount.com', 'chartbeat.com', 'chartbeat.net', 'hotjar.com', 'hotjar.io',
  'mouseflow.com', 'crazyegg.com', 'fullstory.com', 'luckyorange.com', 'clicktale.net', 'inspectlet.com', 'kissmetrics.com',
  'mixpanel.com', 'segment.io', 'heap.io', 'heapanalytics.com', 'amplitude.com', 'nr-data.net',
  'bluekai.com', 'krxd.net', 'demdex.net', 'omtrdc.net', 'everesttech.net', 'exelator.com', 'eyeota.net', 'lotame.com',
  'crwdcntrl.net', 'agkn.com', 'rlcdn.com', 'liveramp.com', 'pippio.com', 'adsymptotic.com', 'bounceexchange.com', 'bouncex.net',
  'zemanta.com', 'yandexadexchange.net', 'mc.yandex.ru', 'adfox.ru', 'statcounter.com', 'histats.com', 'clicky.com',
  'getclicky.com', 'woopra.com', 'parsely.com', 'parse.ly', 'comscore.com', 'imrworldwide.com', 'nielsen.com',
  'ads-twitter.com', 'analytics.twitter.com', 'ads.linkedin.com', 'px.ads.linkedin.com', 'analytics.tiktok.com',
  'ads.tiktok.com', 'business-api.tiktok.com', 'ads.pinterest.com', 'ct.pinterest.com', 'analytics.pinterest.com',
  'ads.reddit.com', 'events.reddit.com', 'adservice.google.com.sg', 'adservice.google.co.uk', 'connect.facebook.net',
  'an.facebook.com', 'pixel.facebook.com', 'google-analytics.com', 'ssl.google-analytics.com', 'googletagmanager.com',
  'stats.g.doubleclick.net', 'app-measurement.com', 'adjust.com', 'appsflyer.com', 'kochava.com',
  'singular.net', 'onesignal.com', 'pushcrew.com', 'pushengage.com', 'subscribers.com',
  'outbrainimg.com', 'taboolasyndication.com', 'trc.taboola.com', 'cdn.taboola.com', 'tracking.yahoo.com', 'sp.analytics.yahoo.com',
  'clarity.ms', 'bat.bing.com', 'c.bing.com', 'adsymptotic.com', 'tiqcdn.com', 'tealiumiq.com', 'ensighten.com',
  'siteintercept.qualtrics.com', 'quantcast.com', 'adsco.re', 'cxense.com', 'permutive.com', 'permutive.app', 'hs-analytics.net', 'hs-banner.com', 'hsadspixel.net', 'usbrowserspeed.com',
  'adsafeprotected.com', 'iasds01.com', 'moatpixel.com', 'brealtime.com', 'smartclip.net', 'videoplaza.tv', 'yieldify.com'
];
