// Where the MiddleBerth API lives.
//
// For local testing the page can be pointed at another API with ?api=..., but only
// at this machine. A link that could point the page anywhere would let someone
// send visitors' passwords to a server of their own.
(function () {
  var DEFAULT_API = 'https://middleberth.samartiwari.me';
  var asked = new URLSearchParams(window.location.search).get('api');
  var local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

  window.MIDDLEBERTH = {
    api: (asked && local.test(asked) ? asked : DEFAULT_API).replace(/\/+$/, ''),
    github: 'https://github.com/samartiwari/MiddleBerth'
  };
})();
