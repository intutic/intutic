import DefaultTheme from 'vitepress/theme'
import './custom.css'
import { inBrowser } from 'vitepress'

declare global {
  interface Window {
    posthog?: any
  }
}

export default {
  extends: DefaultTheme,
  enhanceApp({ router }) {
    if (inBrowser) {
      // Safely load tracking configurations
      const posthogKey = (import.meta.env.VITE_POSTHOG_KEY as string) || ''
      const posthogHost = (import.meta.env.VITE_POSTHOG_HOST as string) || 'https://us.i.posthog.com'

      if (posthogKey) {
        // Initialize the queue array for posthog
        (function(p){
          if(!p.init){
            p._i=[];
            p.init=function(i: string, s: any, a: any){
              function g(t: any,e: any){
                var o=e.split(".");
                2==o.length&&(t=t[o[0]],e=o[1]);
                t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}
              }
              var c=p;
              "undefined"!=typeof a?c=p[a]=[]:a="posthog";
              c.people=c.people||[];
              c.toString=function(t: any){
                var e="posthog";
                "posthog"!==a&&(e+="."+a);
                t&&(e+=" (stub)");
                return e
              };
              c.people.toString=function(){return c.toString(1)+".people"};
              var o="capture identify alias people.set people.set_once set_config register register_once unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset isFeatureEnabled onFeatureFlags getFeatureFlag getFeatureFlagPayload reloadFeatureFlags group updateEarlyAccessFeatureEnrollment getActiveMatchingSurveys getSurveys get_distinct_id".split(" ");
              for(var n=0;n<o.length;n++)g(c,o[n]);
              p._i.push([i,s,a])
            };
            p.__SV=1.2;
          }
        })(window.posthog=window.posthog||[]);

        // Inject the PostHog CDN script tag
        const script = document.createElement('script')
        script.type = 'text/javascript'
        script.async = true
        script.src = `${posthogHost}/static/array.js`
        script.onload = () => {
          if (window.posthog) {
            window.posthog.init(posthogKey, {
              api_host: posthogHost,
              capture_pageview: false, // Handle pageviews manually to align with VitePress router
            })

            // Track initial page view
            window.posthog.capture('$pageview')

            // Track page view reactively on route change
            if (router && typeof router.onAfterRouteChanged === 'function') {
              router.onAfterRouteChanged((to) => {
                window.posthog.capture('$pageview', {
                  $pathname: to,
                })
              })
            }
          }
        }
        document.head.appendChild(script)
      }
    }
  }
}
