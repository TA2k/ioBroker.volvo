'use strict';

var secret;
var namespace;

function encrypt(key, value) {
  var result = '';
  for (var i = 0; i < value.length; ++i) {
    result += String.fromCharCode(key[i % key.length].charCodeAt(0) ^ value.charCodeAt(i));
  }
  return result;
}

function decrypt(key, value) {
  var result = '';
  for (var i = 0; i < value.length; ++i) {
    result += String.fromCharCode(key[i % key.length].charCodeAt(0) ^ value.charCodeAt(i));
  }
  return result;
}

function _(text) {
  if (systemDictionary && systemDictionary[text]) {
    var lang = systemLang || 'en';
    return systemDictionary[text][lang] || systemDictionary[text]['en'] || text;
  }
  return text;
}

function loadHelper(settings, onChange) {
  if (!settings) return;

  $('.value').each(function () {
    var $key = $(this);
    var id = $key.attr('id');
    if (id === 'password') {
      settings[id] = decrypt(secret, settings[id]);
    }

    if ($key.attr('type') === 'checkbox') {
      $key.prop('checked', settings[id]).change(function () {
        onChange();
      });
    } else {
      $key
        .val(settings[id])
        .change(function () {
          onChange();
        })
        .keyup(function () {
          onChange();
        });
    }
  });
  onChange(false);
  M.updateTextFields();
}

// Called by the admin adapter when the settings page loads
function load(settings, onChange) { // eslint-disable-line no-unused-vars
  socket.emit('getObject', 'system.config', function (_err, obj) {
    secret = (obj.native ? obj.native.secret : '') || 'Zgfr56gFe87jJOM';
    loadHelper(settings, onChange);
  });

  // OTP Login flow
  $('#btn-start-login').click(function () {
    var user = $('#user').val();
    var password = $('#password').val();

    if (!user || !password) {
      $('#otp-status').text(_('Please enter username and password first.')).css('color', 'red');
      return;
    }

    $('#otp-status').text(_('Starting login... Sending OTP to your email...')).css('color', 'orange');
    $('#btn-start-login').prop('disabled', true);

    var parts = window.location.hash.replace('#', '').split('/');
    namespace = parts[0] || 'volvo.0';

    sendTo(namespace, 'startLogin', { user: user, password: decrypt(secret, encrypt(secret, password)) }, function (result) {
      $('#btn-start-login').prop('disabled', false);
      if (result && result.success) {
        $('#otp-status').text(result.message).css('color', 'green');
        $('#otp-section').show();
      } else {
        $('#otp-status').text(_('Login failed: ') + (result ? result.message : 'Unknown error')).css('color', 'red');
      }
    });
  });

  $('#btn-submit-otp').click(function () {
    var otp = $('#otp-code').val();
    if (!otp) {
      $('#otp-status').text(_('Please enter the OTP code.')).css('color', 'red');
      return;
    }

    $('#otp-status').text(_('Verifying OTP...')).css('color', 'orange');
    $('#btn-submit-otp').prop('disabled', true);

    sendTo(namespace, 'submitOtp', { otp: otp }, function (result) {
      $('#btn-submit-otp').prop('disabled', false);
      if (result && result.success) {
        $('#otp-status').text(result.message).css('color', 'green');
        $('#otp-section').hide();
        $('#otp-code').val('');
      } else {
        $('#otp-status').text(_('OTP failed: ') + (result ? result.message : 'Unknown error')).css('color', 'red');
      }
    });
  });
}

// Called by the admin adapter when the user presses save
function save(callback) { // eslint-disable-line no-unused-vars
  var obj = {};
  $('.value').each(function () {
    var $this = $(this);
    var id = $this.attr('id');

    if ($this.attr('type') === 'checkbox') {
      obj[id] = $this.prop('checked');
    } else {
      var value = $this.val();
      if (id === 'password') {
        value = encrypt(secret, value);
      }
      obj[id] = value;
    }
  });

  callback(obj);
}
