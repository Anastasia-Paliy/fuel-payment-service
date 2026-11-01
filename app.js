/**
 * Заправка в рейсе — прототип водительского UI (pure JS + FakeApi).
 *
 * Разделение: стили и статичная разметка (template) — в index.html;
 * app.js — состояние, API, сборка экранов из данных (списки АЗС и т.п.).
 * Экраны: home → fuel → stations → pump → volume → confirm → process → result.
 * История и pending — localStorage.
 */
!(function () {
  "use strict";
  var LETTERS = "АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЩЭЮЯ",
    // chip — короткая подпись на экране выбора; title — в фильтре на списке АЗС
    FUEL_GROUPS = [
      {
        id: "diesel",
        title: "ДТ",
        chip: "ДТ",
        sub: "дизель",
        codes: ["diesel", "diesel_premium", "diesel_winter"]
      },
      {
        id: "ai92",
        title: "АИ-92",
        chip: "АИ-92",
        sub: "бензин",
        codes: ["ai92"]
      },
      {
        id: "ai95",
        title: "АИ-95",
        chip: "АИ-95",
        sub: "бензин",
        codes: ["ai95", "ai100"]
      },
      {
        id: "propane",
        title: "Пропан",
        chip: "Пропан",
        sub: "газ",
        codes: ["propane"]
      }
    ],
    // Имена топлива по бренду (getStations имён не отдаёт — зеркало справочника FakeApi).
    BRAND_FUEL_NAMES = {
      "Магистраль": {
        diesel: "ДТ",
        diesel_premium: "ДТ Евро-5 Опти",
        ai92: "АИ-92",
        ai95: "АИ-95"
      },
      "Север Ойл": { diesel: "Дизель", ai92: "Регуляр-92", ai95: "Г-95" },
      "ТрассНефть": {
        diesel: "ДТ-Л",
        diesel_winter: "ДТ Арктика",
        ai95: "95 Премиум"
      },
      "Волга-Топливо": {
        diesel: "ДТ",
        ai92: "АИ-92",
        ai95: "АИ-95",
        ai100: "АИ-100"
      },
      "Колесо": { diesel: "ДТ ЭКО", ai92: "АИ-92", propane: "Пропан" }
    },
    api = window.FakeApi;
  if (api) {
    var state = {
        screen: "boot",
        online: false !== navigator.onLine,
        loading: false,
        error: null,
        trip: null,
        tripFromCache: false,
        history: loadJson("zapravka.history.v1", []),
        activeFueling: null,
        pending: loadJson("zapravka.pending.v1", null),
        driver: null,
        stations: [],
        stationDetail: null,
        fuelGroupId: "diesel",
        radiusKm: 40,
        sortBy: "price",
        selectedStationId: null,
        selectedPump: null,
        fuelCode: null,
        fuelName: null,
        price: null,
        volume: 50,
        litersMin: 10,
        litersMax: 150,
        clientRequestId: null,
        sending: false,
        fueling: null,
        lastFueling: null,
        pollId: null,
        tickId: null,
        overlay: null,
        sheet: null,
        sheetData: null,
        netScreen: null,
        linkOkBanner: null
      },
      root = document.getElementById("app");
    (window.addEventListener("online", function () {
      state.online = true;
      if ("home" === state.screen) refreshHome();
      else if ("process" === state.screen && state.fueling) {
        setState(
          { linkOkBanner: "Связь есть · статус обновлён" },
          { render: false }
        );
        startPolling(state.fueling.id);
        setTimeout(function () {
          if (state.linkOkBanner) setState({ linkOkBanner: null });
        }, 6000);
      } else render();
    }),
      window.addEventListener("offline", function () {
        ((state.online = false), render());
      }),
      (window.App = {
        state: state,
        boot: boot,
        goHome: goHome,
        pushHistory: upsertHistory,
        recommendedLiters: recommendedLiters,
        hardMaxLiters: hardMaxLiters
      }),
      boot());
  } else document.getElementById("app").textContent = "Нет FakeApi";

  /* ========== helpers: DOM / format / storage ========== */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    return (cls && (n.className = cls), null != text && (n.textContent = text), n);
  }

  /** Клон <template id="..."> из index.html */
  function fromTemplate(id) {
    var tpl = document.getElementById(id);
    return tpl && tpl.content ? tpl.content.cloneNode(true) : null;
  }

  /** Ширина прогресса через CSS-переменную --pct (см. index.html) */
  function setProgress(fillEl, pct) {
    fillEl.style.setProperty("--pct", Math.max(0, Math.min(100, pct)) + "%");
  }

  function priceTierClass(tier) {
    if ("dear" === tier) return "t-dear";
    if ("mid" === tier) return "t-mid";
    return "t-cheap";
  }

  function money(n) {
    return (
      Math.round(Number(n) || 0)
        .toString()
        .replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " ₽"
    );
  }

  function perLiter(n) {
    return (
      (function (n) {
        var x = Math.round(100 * (Number(n) || 0)) / 100;
        return (
          String(x)
            .replace(".", ",")
            .replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " ₽"
        );
      })(n).replace(" ₽", "") + " ₽/л"
    );
  }

  function litersStr(n) {
    var x = Math.round(10 * (Number(n) || 0)) / 10;
    return String(x).replace(".", ",");
  }

  function formatDist(km) {
    if (!(km >= 0)) return "—";
    if (km < 1) return Math.round(1e3 * km) + " м";
    var n = km < 10 ? km.toFixed(1) : String(Math.round(km));
    return String(n).replace(".", ",") + " км";
  }

  function loadJson(key, fb) {
    try {
      var r = localStorage.getItem(key);
      return r ? JSON.parse(r) : fb;
    } catch (e) {
      return fb;
    }
  }

  function saveJson(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch (e) {}
  }

  function fuelGroupById(id) {
    for (var i = 0; i < FUEL_GROUPS.length; i++)
      if (FUEL_GROUPS[i].id === id) return FUEL_GROUPS[i];
    return FUEL_GROUPS[0];
  }

  function pickFuelCode(station, group) {
    for (var codes = group.codes, i = 0; i < codes.length; i++)
      if (station.prices && null != station.prices[codes[i]]) return codes[i];
    return null;
  }

  function pumpLabel(brand, num) {
    return "Колесо" === brand && num >= 1 && num <= 28
      ? LETTERS.charAt(num - 1) + " · " + num
      : String(num);
  }

  function reasonLabel(r) {
    return (
      {
        DRIVER_CANCELLED: "Отменено водителем",
        PUMP_TIMEOUT: "Нет пистолета",
        STATION_NO_RESPONSE: "АЗС не ответила"
      }[r] ||
      r ||
      "Не удалось"
    );
  }

  /* ========== state / API / polling ========== */
  function setState(patch, opts) {
    (Object.keys(patch).forEach(function (k) {
      state[k] = patch[k];
    }),
      (opts && false === opts.render) || render());
  }

  function cacheTrip(trip) {
    saveJson("zapravka.cache.v1", {
      trip: trip,
      at: Date.now()
    });
  }

  function previousTripId() {
    if (state.trip && state.trip.id) return state.trip.id;
    var c = loadJson("zapravka.cache.v1", null);
    return c && c.trip && c.trip.id ? c.trip.id : null;
  }

  // Смена id рейса → локальные данные прошлого рейса больше не актуальны.
  function clearTripLocalData() {
    stopPoll();
    state.history = [];
    saveJson("zapravka.history.v1", []);
    savePending(null);
    setState(
      {
        history: [],
        pending: null,
        activeFueling: null,
        fueling: null,
        lastFueling: null,
        overlay: null,
        sheet: null,
        sheetData: null,
        clientRequestId: null,
        selectedStationId: null,
        selectedPump: null,
        stationDetail: null
      },
      { render: false }
    );
  }

  /** Кладёт trip в кэш; при смене trip.id чистит историю / pending / заказ. */
  function applyTrip(trip) {
    var prev = previousTripId();
    var changed = !!(prev && trip && trip.id && prev !== trip.id);
    if (changed) {
      clearTripLocalData();
      state.overlay = "tripChanged";
      state.sheet = null;
      state.sheetData = null;
      state.netScreen = null;
    }
    cacheTrip(trip);
    return changed;
  }

  function upsertHistory(entry) {
    var list = state.history.slice();
    var i = -1;
    if (entry.fuelingId) {
      for (var k = 0; k < list.length; k++) {
        if (list[k].fuelingId === entry.fuelingId) {
          i = k;
          break;
        }
      }
    }
    if (i >= 0) list[i] = Object.assign({}, list[i], entry);
    else list.unshift(entry);
    if (list.length > 30) list = list.slice(0, 30);
    state.history = list;
    saveJson("zapravka.history.v1", list);
  }

  function whenLabelNow() {
    var d = new Date();
    var months = [
      "января",
      "февраля",
      "марта",
      "апреля",
      "мая",
      "июня",
      "июля",
      "августа",
      "сентября",
      "октября",
      "ноября",
      "декабря"
    ];
    return (
      d.getDate() +
      " " +
      months[d.getMonth()] +
      ", " +
      String(d.getHours()).padStart(2, "0") +
      ":" +
      String(d.getMinutes()).padStart(2, "0")
    );
  }

  function stationAddressForFueling(f) {
    return (
      (state.stationDetail && state.stationDetail.address) ||
      f.stationAddress ||
      ""
    );
  }

  function historyPumpLabel(f) {
    var brand =
      (state.stationDetail && state.stationDetail.brand) ||
      (f && f.stationBrand) ||
      "";
    return pumpLabel(brand, f && f.pump);
  }

  function historySnapshot(f, extra) {
    return Object.assign(
      {
        stationName: f.stationName,
        stationAddress: stationAddressForFueling(f),
        price: f.price,
        amountHeld: f.amountHeld,
        fuelingId: f.id,
        fuelName: f.fuelName || "",
        fuelCode: f.fuel || "",
        pump: f.pump != null ? f.pump : null,
        pumpLabel: historyPumpLabel(f)
      },
      extra || {}
    );
  }

  /** Запись в историю сразу при холде; позже обновляется по fuelingId. */
  function rememberFuelingStart(f) {
    if (!f || !f.id) return;
    upsertHistory(
      historySnapshot(f, {
        active: true,
        ok: false,
        holdReturned: false,
        underfill: false,
        liters: f.liters,
        orderedLiters: f.liters,
        factLiters: null,
        factAmount: null,
        reason: "",
        whenLabel: whenLabelNow()
      })
    );
  }

  function ensureHistoryForActive(f) {
    if (!f || !f.id) return;
    var found = state.history.some(function (h) {
      return h.fuelingId === f.id;
    });
    if (!found) rememberFuelingStart(f);
  }

  function isUnderfillHistory(h) {
    if (!h || !h.ok || h.active) return false;
    if (h.underfill) return true;
    var ordered =
      h.orderedLiters != null ? Number(h.orderedLiters) : Number(h.liters);
    var fact = h.factLiters != null ? Number(h.factLiters) : NaN;
    if (!isNaN(ordered) && !isNaN(fact) && fact < ordered - 0.001) return true;
    var held = Number(h.amountHeld) || 0;
    var charged = Number(h.factAmount) || 0;
    return held - charged > 0.01;
  }

  function holdRefundAmount(h) {
    var held = Number(h.amountHeld) || 0;
    var charged = Number(h.factAmount) || 0;
    return Math.round((held - charged) * 100) / 100;
  }

  /** Закрыть запись истории по финальному getFueling (без смены экрана). */
  function applyFuelingToHistory(f) {
    if (!f || !f.id) return;
    if ("completed" !== f.status && "cancelled" !== f.status) return;
    var ok = "completed" === f.status;
    var ordered = Number(f.liters);
    var factL = ok ? Number(f.factLiters) : null;
    var underfill =
      ok && factL != null && !isNaN(factL) && factL < ordered - 0.001;
    upsertHistory(
      historySnapshot(f, {
        active: false,
        ok: ok,
        holdReturned: !ok,
        underfill: underfill,
        liters: ok ? f.factLiters : f.liters,
        orderedLiters: f.liters,
        factLiters: f.factLiters,
        factAmount: ok ? f.factAmount : f.amountHeld,
        reason: ok ? "" : reasonLabel(f.reason),
        whenLabel: whenLabelNow()
      })
    );
  }

  /**
   * Догон: в истории active:true, а в FakeApi заказ уже completed/cancelled
   * (холд снят, polling/finishFueling не успели обновить запись).
   */
  function reconcileOpenHistory() {
    var open = state.history.filter(function (h) {
      return h.active && h.fuelingId;
    });
    if (!open.length) return Promise.resolve();
    return Promise.all(
      open.map(function (h) {
        return callApi("getFueling", [h.fuelingId])
          .then(function (f) {
            applyFuelingToHistory(f);
            return f;
          })
          .catch(function () {
            return null;
          });
      })
    );
  }

  function savePending(p) {
    if (((state.pending = p), p)) saveJson("zapravka.pending.v1", p);
    else
      try {
        localStorage.removeItem("zapravka.pending.v1");
      } catch (e) {}
  }

  function callApi(method, args) {
    return api[method]
      .apply(api, args || [])
      .then(function (res) {
        return ((state.online = true), res);
      })
      .catch(function (err) {
        var e = (function (err) {
          return err
            ? {
                code: err.code || "UNKNOWN",
                message: err.message || "Ошибка",
                details: err.details || {}
              }
            : {
                code: "UNKNOWN",
                message: "Ошибка"
              };
        })(err);
        return ("NETWORK_ERROR" === e.code && (state.online = false), Promise.reject(e));
      });
  }

  function stopPoll() {
    (state.pollId && (clearInterval(state.pollId), (state.pollId = null)),
      state.tickId && (clearInterval(state.tickId), (state.tickId = null)));
  }

  function resetOrder(keepFuel) {
    (stopPoll(),
      setState(
        {
          selectedStationId: null,
          selectedPump: null,
          stationDetail: null,
          fuelCode: keepFuel ? state.fuelCode : null,
          fuelName: keepFuel ? state.fuelName : null,
          price: null,
          volume: 50,
          clientRequestId: null,
          sending: false,
          fueling: null,
          sheet: null,
          sheetData: null,
          netScreen: null
        },
        {
          render: false
        }
      ));
  }

  /* ========== boot / home / navigation ========== */
  function boot() {
    (stopPoll(),
      setState({
        screen: "boot",
        loading: true,
        error: null,
        overlay: null,
        sheet: null
      }),
      Promise.all([
        callApi("getTrip")
          .then(function (trip) {
            var changed = applyTrip(trip);
            return {
              trip: trip,
              fromCache: false,
              tripChanged: changed
            };
          })
          .catch(function (err) {
            var c,
              t = (c = loadJson("zapravka.cache.v1", null)) && c.trip ? c.trip : null;
            return t
              ? {
                  trip: t,
                  fromCache: true,
                  tripChanged: false,
                  err: err
                }
              : Promise.reject(err);
          }),
        callApi("getActiveFueling").catch(function () {
          return null;
        })
      ])
        .then(function (res) {
          var tripInfo = res[0];
          var active = tripInfo.tripChanged ? null : res[1];
          if (active) ensureHistoryForActive(active);
          return reconcileOpenHistory().then(function () {
            setState({
              loading: false,
              screen: "home",
              trip: tripInfo.trip,
              tripFromCache: !!tripInfo.fromCache,
              online: !tripInfo.fromCache,
              error: tripInfo.err || null,
              activeFueling: active,
              fueling: active || state.fueling,
              overlay: tripInfo.tripChanged ? "tripChanged" : null
            });
            if (active && !tripInfo.tripChanged) startPolling(active.id);
          });
        })
        .catch(function (err) {
          setState({
            loading: false,
            screen: "home",
            trip: null,
            error: err,
            online: false
          });
        }));
  }

  function refreshHome() {
    if (state.loading) return;
    setState({
      loading: true,
      error: null
    });
    callApi("getTrip")
      .then(function (trip) {
        var changed = applyTrip(trip);
        return callApi("getActiveFueling").then(function (active) {
          if (changed) active = null;
          if (active) ensureHistoryForActive(active);
          return reconcileOpenHistory().then(function () {
            setState({
              loading: false,
              trip: trip,
              tripFromCache: false,
              online: true,
              activeFueling: active,
              fueling: active || null,
              screen: "home",
              overlay: changed ? "tripChanged" : null,
              error: null
            });
            if (active && !changed) startPolling(active.id);
            else if (!active) stopPoll();
          });
        });
      })
      .catch(function (err) {
        setState({
          loading: false,
          error: err,
          online: false
        });
      });
  }

  function goHome() {
    (stopPoll(),
      setState(
        {
          screen: "home",
          overlay: null,
          sheet: null,
          netScreen: null,
          sending: false,
          loading: false,
          fueling: null,
          stationDetail: null
        },
        { render: false }
      ),
      refreshHome());
  }

  function onStartFueling() {
    if (!state.online || state.tripFromCache || state.loading) return;
    if (state.activeFueling) {
      openActiveFueling();
      return;
    }
    // Перед заказом подтягиваем свежий лимит рейса (как «Обновить»).
    setState({ loading: true, error: null });
    callApi("getTrip")
      .then(function (trip) {
        var changed = applyTrip(trip);
        if (changed) {
          setState({
            loading: false,
            trip: trip,
            tripFromCache: false,
            online: true,
            screen: "home",
            overlay: "tripChanged"
          });
          return;
        }
        return callApi("getActiveFueling").then(function (active) {
          if (active) {
            setState({ trip: trip, tripFromCache: false }, { render: false });
            showFueling(active, "Уже есть заказ · второй холд не создан");
            return;
          }
          resetOrder(false);
          setState({
            loading: false,
            trip: trip,
            tripFromCache: false,
            online: true,
            screen: "fuel",
            fuelGroupId: "diesel",
            overlay: null
          });
        });
      })
      .catch(function (err) {
        setState({
          loading: false,
          error: err,
          online: false,
          screen: "home"
        });
      });
  }

  function openActiveFueling() {
    if (state.activeFueling) showFueling(state.activeFueling);
  }

  /* ========== stations: load, enrich, select ========== */
  function loadStations(opts) {
    var force = opts && opts.force;
    if (!force && state.loading && "stations" === state.screen) return;
    setState({
      loading: true,
      error: null,
      screen: "stations",
      netScreen: null
    });
    Promise.all([callApi("getStations"), callApi("getDriverLocation")])
      .then(function (res) {
        setState({
          loading: false,
          stations: res[0],
          driver: res[1],
          online: true
        });
      })
      .catch(function (err) {
        setState({
          loading: false,
          error: err,
          netScreen: "stations",
          screen: "net"
        });
      });
  }

  // Назад к списку АЗС: заново тянем станции и координаты водителя.
  function backToStations() {
    setState(
      {
        sheet: null,
        sheetData: null,
        selectedStationId: null,
        selectedPump: null,
        stationDetail: null
      },
      { render: false }
    );
    loadStations();
  }

  // Свежий getStation: занятость колонок как в API. keepPump — сохранить выбор, если ещё free.
  function refreshStationDetail(opts) {
    opts = opts || {};
    var stationId = state.selectedStationId,
      fuelCode = state.fuelCode,
      keepPump = !!opts.keepPump,
      prevPump = state.selectedPump;
    if (!stationId || !fuelCode) return Promise.resolve(null);
    return callApi("getStation", [stationId])
      .then(function (detail) {
        var fuel = null;
        detail.fuels.forEach(function (f) {
          if (f.code === fuelCode) fuel = f;
        });
        var selectedPump = keepPump ? prevPump : null;
        if (selectedPump != null) {
          var pump = null;
          detail.pumps.forEach(function (p) {
            if (p.number === selectedPump) pump = p;
          });
          var ok =
            pump && "free" === pump.status && pump.fuels.indexOf(fuelCode) >= 0;
          if (!ok) selectedPump = null;
        }
        setState({
          stationDetail: detail,
          fuelName: fuel ? fuel.name : fuelCode,
          price: fuel ? fuel.price : state.price,
          litersMin: detail.litersMin,
          litersMax: detail.litersMax,
          selectedPump: selectedPump,
          online: true
        });
        return detail;
      })
      .catch(function () {
        setState({ online: false });
        return null;
      });
  }

  /** Обновить цену АЗС и доступный лимит на экранах объёма / подтверждения. */
  function refreshOrderPriceAndLimit() {
    if (state.loading || state.sending) return;
    var stayOn = state.screen;
    var stationId = state.selectedStationId;
    var fuelCode = state.fuelCode;
    if (!stationId || !fuelCode) return;
    setState({ loading: true, error: null });
    Promise.all([callApi("getTrip"), callApi("getStation", [stationId])])
      .then(function (res) {
        var trip = res[0];
        var detail = res[1];
        var changed = applyTrip(trip);
        if (changed) {
          setState({
            loading: false,
            trip: trip,
            tripFromCache: false,
            online: true,
            screen: "home",
            overlay: "tripChanged"
          });
          return;
        }
        var fuel = null;
        detail.fuels.forEach(function (f) {
          if (f.code === fuelCode) fuel = f;
        });
        var newPrice = fuel ? fuel.price : state.price;
        var newMin = detail.litersMin;
        var newMax = detail.litersMax;
        var left = Number(trip.limitLeft) || 0;
        var byMoney = Math.floor(left / (Number(newPrice) || 1));
        var hard = Math.max(newMin, Math.min(newMax, byMoney));
        var vol = Math.max(newMin, Math.min(hard, Number(state.volume) || newMin));
        setState({
          loading: false,
          trip: trip,
          tripFromCache: false,
          online: true,
          stationDetail: detail,
          fuelName: fuel ? fuel.name : fuelCode,
          price: newPrice,
          litersMin: newMin,
          litersMax: newMax,
          volume: vol,
          screen: stayOn === "confirm" || stayOn === "volume" ? stayOn : state.screen,
          error: null
        });
      })
      .catch(function (err) {
        setState({
          loading: false,
          error: err,
          online: false
        });
      });
  }

  function enrichedStations() {
    var group = fuelGroupById(state.fuelGroupId),
      driver = state.driver || {
        lat: 56.0712,
        lon: 40.0368
      },
      list = [];
    state.stations.forEach(function (st) {
      if (
        (function (st, group) {
          return null != pickFuelCode(st, group);
        })(st, group)
      ) {
        var a,
          b,
          dy,
          dx,
          code = pickFuelCode(st, group),
          price = st.prices[code],
          dist =
            ((b = st),
            (dy = 111 * ((a = driver).lat - b.lat)),
            (dx = 62 * (a.lon - b.lon)),
            Math.sqrt(dy * dy + dx * dx));
        list.push({
          st: st,
          code: code,
          price: price,
          dist: dist,
          inRadius: dist <= state.radiusKm,
          near: dist <= 1.5
        });
      }
    });
    var prices = list
        .map(function (x) {
          return x.price;
        })
        .sort(function (a, b) {
          return a - b;
        }),
      cheapest = prices.length ? prices[0] : 0,
      p33 = prices.length ? prices[Math.floor(0.33 * prices.length)] : 0,
      p66 = prices.length ? prices[Math.floor(0.66 * prices.length)] : 0;
    list.forEach(function (x) {
      x.price <= cheapest + 0.001
        ? (x.tier = "deal")
        : x.price <= p33
          ? (x.tier = "cheap")
          : x.price <= p66
            ? (x.tier = "mid")
            : (x.tier = "dear");
    });
    var nearest = null;
    list.forEach(function (x) {
      (!nearest || x.dist < nearest.dist) && (nearest = x);
    });
    var inRad = list.filter(function (x) {
      return x.inRadius;
    });
    return (
      inRad.sort(function (a, b) {
        return "dist" === state.sortBy
          ? a.dist - b.dist || a.price - b.price
          : a.price - b.price || a.dist - b.dist;
      }),
      {
        nearest: nearest && nearest.near ? nearest : null,
        list: inRad,
        all: list,
        cheapest: cheapest
      }
    );
  }

  // Для mid/dear — мягкое предупреждение, если в радиусе есть заметно выгоднее
  // (и это не та же АЗС: в радиусе могут быть только дорогие).
  function selectStation(item, force) {
    if (state.loading) return;
    if (!force && ("dear" === item.tier || "mid" === item.tier)) {
      var data = enrichedStations();
      var better = null;
      data.list.forEach(function (x) {
        if (x.st.id === item.st.id) return;
        if (!(x.price < item.price - 0.001)) return;
        if (!better || x.price < better.price) better = x;
      });
      if (better) {
        setState({
          sheet: "expensive",
          sheetData: {
            item: item,
            better: better
          }
        });
        return;
      }
    }
    openStation(item.st.id, item.code, item.price);
  }

  function openStation(stationId, fuelCode, price) {
    if (state.loading) return;
    setState({
      loading: true,
      selectedStationId: stationId,
      fuelCode: fuelCode,
      price: price,
      selectedPump: null
    });
    callApi("getStation", [stationId])
      .then(function (detail) {
        var fuel = null;
        detail.fuels.forEach(function (f) {
          if (f.code === fuelCode) fuel = f;
        });
        setState({
          loading: false,
          stationDetail: detail,
          fuelName: fuel ? fuel.name : fuelCode,
          price: fuel ? fuel.price : price,
          litersMin: detail.litersMin,
          litersMax: detail.litersMax,
          screen: "pump",
          sheet: null
        });
      })
      .catch(function (err) {
        setState({
          loading: false,
          error: err,
          netScreen: "stations",
          screen: "net"
        });
      });
  }

  /* ========== volume / soft budget (50% of getTrip().limitTotal) ========== */
  function tripLimitTotal() {
    var n = Number(state.trip && state.trip.limitTotal);
    return n > 0 ? n : 0;
  }

  function hardMaxLiters() {
    var price = Number(state.price) || 1,
      byMoney = Math.floor((Number(state.trip && state.trip.limitLeft) || 0) / price);
    return Math.max(state.litersMin, Math.min(state.litersMax, byMoney));
  }

  function fuelDisplayName(brand, code) {
    var m = BRAND_FUEL_NAMES[brand];
    return (m && m[code]) || code || "";
  }

  // Мягкий бюджет: min(50% остатка, 30% limitTotal).
  function budgetRub() {
    var left = Number(state.trip && state.trip.limitLeft) || 0,
      total = tripLimitTotal(),
      a = Math.round(0.5 * left),
      b = Math.round(0.3 * total);
    if (total > 0 && left > 0) return Math.min(a, b);
    if (total > 0) return b;
    return a;
  }

  function recommendedLiters() {
    var price = Number(state.price) || 1,
      byBudget = Math.floor(budgetRub() / price);
    return Math.max(state.litersMin, Math.min(hardMaxLiters(), byBudget));
  }

  function clampVolume(v) {
    var max = hardMaxLiters(),
      min = state.litersMin;
    return ((v = Math.round(Number(v) || min)) < min && (v = min), v > max && (v = max), v);
  }

  function enterVolume() {
    var rec = recommendedLiters();
    setState({
      screen: "volume",
      volume: clampVolume(Math.min(rec, hardMaxLiters())),
      sheet: null
    });
  }

  function ensureClientRequestId() {
    return (
      state.clientRequestId ||
        (state.clientRequestId =
          ("req" || "id") +
          "_" +
          Date.now().toString(36) +
          Math.floor(1e5 * Math.random()).toString(36)),
      state.clientRequestId
    );
  }

  function buildStartPayload() {
    return {
      stationId: state.selectedStationId,
      pump: state.selectedPump,
      fuel: state.fuelCode,
      liters: state.volume,
      price: state.price,
      clientRequestId: ensureClientRequestId()
    };
  }

  /* ========== start / poll / finish / cancel ========== */
  function showFueling(f, banner) {
    if (!f) return;
    ensureHistoryForActive(f);
    setState({
      sending: false,
      loading: false,
      fueling: f,
      activeFueling: f,
      screen: "process",
      netScreen: null,
      overlay: null,
      lastFueling: null,
      online: true,
      linkOkBanner: banner || null
    });
    startPolling(f.id);
    if (banner) {
      setTimeout(function () {
        if (state.linkOkBanner === banner) setState({ linkOkBanner: null });
      }, 6000);
    }
  }

  function openFuelingById(id) {
    if (!id || state.loading || state.sending) return;
    setState({ loading: true, error: null });
    callApi("getFueling", [id])
      .then(function (f) {
        applyFuelingToHistory(f);
        if ("completed" === f.status || "cancelled" === f.status) {
          setState({ loading: false, online: true }, { render: false });
          refreshHome();
          return;
        }
        showFueling(f);
      })
      .catch(function (err) {
        setState({
          loading: false,
          error: err,
          online: "NETWORK_ERROR" === err.code ? false : state.online
        });
      });
  }

  function submitFueling() {
    if (state.sending) return;
    var payload = buildStartPayload();
    var started = false;
    savePending({
      clientRequestId: payload.clientRequestId,
      payload: payload,
      at: Date.now()
    });
    setState({
      sending: true,
      screen: "confirm"
    });
    callApi("getActiveFueling")
      .then(function (existing) {
        if (existing) {
          savePending(null);
          showFueling(existing, "Уже есть заказ · второй холд не создан");
          return;
        }
        started = true;
        return callApi("startFueling", [payload]).then(function (f) {
          savePending(null);
          rememberFuelingStart(f);
          setState({
            sending: false,
            fueling: f,
            activeFueling: f,
            screen: "process",
            online: true
          });
          startPolling(f.id);
        });
      })
      .catch(function (err) {
        if ("NETWORK_ERROR" === err.code && !started) {
          setState({
            sending: false,
            screen: "confirm",
            online: false,
            sheet: "error",
            sheetData: err
          });
          return;
        }
        if ("NETWORK_ERROR" !== err.code) {
          if ("PRICE_CHANGED" === err.code)
            return (
              setState({
                sending: false,
                sheet: "priceChanged",
                sheetData: err.details,
                clientRequestId: null
              }),
              void savePending(null)
            );
          if ("PUMP_BUSY" === err.code)
            return (
              setState({
                sending: false,
                sheet: "pumpBusy",
                clientRequestId: null,
                selectedPump: null
              }),
              void savePending(null)
            );
          if ("LIMIT_EXCEEDED" === err.code)
            return (
              setState({
                sending: false,
                sheet: "limit",
                sheetData: err.details,
                clientRequestId: null
              }),
              void savePending(null)
            );
          setState({
            sending: false,
            sheet: "error",
            sheetData: err,
            clientRequestId: null
          });
          savePending(null);
        } else
          setState({
            sending: false,
            netScreen: "afterStart",
            screen: "net"
          });
      });
  }

  function retrySameOrder() {
    var p = state.pending && state.pending.payload;
    if (!p) p = buildStartPayload();
    setState({
      sending: true,
      screen: "confirm",
      netScreen: null
    });
    callApi("getActiveFueling")
      .then(function (existing) {
        if (existing) {
          savePending(null);
          showFueling(existing, "Уже есть заказ · второй холд не создан");
          return;
        }
        return callApi("startFueling", [p]).then(function (f) {
          savePending(null);
          rememberFuelingStart(f);
          setState({
            sending: false,
            fueling: f,
            activeFueling: f,
            screen: "process"
          });
          startPolling(f.id);
        });
      })
      .catch(function (err) {
        "NETWORK_ERROR" !== err.code
          ? setState({
              sending: false,
              sheet: "error",
              sheetData: err,
              screen: "confirm"
            })
          : setState({
              sending: false,
              netScreen: "afterStart",
              screen: "net"
            });
      });
  }

  function checkActiveAfterNet() {
    setState({ loading: true });
    callApi("getActiveFueling")
      .then(function (f) {
        if (f) {
          savePending(null);
          rememberFuelingStart(f);
          setState({
            loading: false,
            fueling: f,
            activeFueling: f,
            screen: "process",
            netScreen: null,
            online: true,
            linkOkBanner: "Связь есть · статус обновлён"
          });
          startPolling(f.id);
          setTimeout(function () {
            if (state.linkOkBanner) setState({ linkOkBanner: null });
          }, 6000);
        } else {
          setState({
            loading: false,
            netScreen: "beforeStart",
            screen: "net"
          });
        }
      })
      .catch(function () {
        // Не уводим на отдельный «догоняем статус»: остаёмся на процессе, если заказ есть.
        if (state.fueling) {
          setState({
            loading: false,
            screen: "process",
            netScreen: null,
            online: false
          });
        } else {
          setState({
            loading: false,
            netScreen: "afterStart",
            screen: "net"
          });
        }
      });
  }

  function startPolling(id) {
    function tick() {
      callApi("getFueling", [id])
        .then(function (f) {
          var done = "completed" === f.status || "cancelled" === f.status;
          setState(
            {
              fueling: f,
              online: true,
              activeFueling: done ? null : f
            },
            { render: false }
          );
          if (done) {
            stopPoll();
            finishFueling(f);
          } else {
            render();
          }
        })
        .catch(function () {
          setState({ online: false });
          render();
        });
    }
    stopPoll();
    tick();
    state.pollId = setInterval(tick, 1500);
    // Тикающий таймер «до отмены» на экране пистолета.
    state.tickId = setInterval(function () {
      if ("process" !== state.screen || !state.fueling) return;
      var st = state.fueling.status;
      if ("accepted" === st || "waiting_nozzle" === st) render();
    }, 1000);
  }

  // Итог заправки: обновляет запись, созданную при холде (по fuelingId).
  function finishFueling(f) {
    stopPoll();
    var alreadyDone =
      state.lastFueling &&
      state.lastFueling.id === f.id &&
      ("completed" === state.lastFueling.status || "cancelled" === state.lastFueling.status);
    // Всегда синхронизируем историю: иначе active:true может зависнуть.
    applyFuelingToHistory(f);
    if (alreadyDone) {
      savePending(null);
      setState({
        lastFueling: f,
        fueling: f,
        activeFueling: null,
        sending: false
      });
      return;
    }
    savePending(null);
    setState({
      lastFueling: f,
      fueling: f,
      activeFueling: null,
      sending: false,
      screen: "result"
    });
    callApi("getTrip")
      .then(function (trip) {
        var changed = applyTrip(trip);
        setState({
          trip: trip,
          tripFromCache: false,
          screen: changed ? "home" : "result",
          overlay: changed ? "tripChanged" : state.overlay
        });
      })
      .catch(function () {});
  }

  function cancelFueling() {
    var f = state.fueling;
    if (!f) return;
    if ("accepted" !== f.status && "waiting_nozzle" !== f.status) return;
    // Останавливаем poll до ответа API — иначе finishFueling вызовется дважды.
    stopPoll();
    setState({
      sending: true
    });
    callApi("cancelFueling", [f.id])
      .then(function (res) {
        finishFueling(res);
      })
      .catch(function (err) {
        if ("NETWORK_ERROR" === err.code) {
          setState({
            sending: false,
            netScreen: "cancel",
            screen: "net"
          });
          return;
        }
        if ("CANNOT_CANCEL" === err.code) {
          setState({
            sending: false,
            sheet: "cannotCancel"
          });
          // Налив мог уже начаться — снова слушаем статус.
          if (f.id) startPolling(f.id);
          return;
        }
        setState({
          sending: false,
          sheet: "error",
          sheetData: err
        });
        if (f.id) startPolling(f.id);
      });
  }

  /* ========== render: screens + overlays ========== */
  function render() {
    var view, msg, s, c;
    ((root.innerHTML = ""),
      "boot" === state.screen ||
      (state.loading && "stations" === state.screen && !state.stations.length)
        ? ((msg = "stations" === state.screen ? "Ищем АЗС…" : "Загружаем…"),
          (s = el("div", "screen")),
          (c = el("div", "center")).appendChild(el("div", "spinner")),
          c.appendChild(el("div", "muted", msg || "Загрузка…")),
          s.appendChild(c),
          (view = s))
        : (view =
            "home" === state.screen
              ? viewHome()
              : "history" === state.screen
                ? viewHistory()
                : "fuel" === state.screen
                  ? (function () {
                      var s = el("div", "screen"),
                        body = el("div", "screen-body");
                      (body.appendChild(topBack("Выбор топлива", goHome)),
                        body.appendChild(stepsBar(0)),
                        body.appendChild(el("div", "muted", "Покажем АЗС, где оно есть")));
                      var row = el("div", "chiprow");
                      FUEL_GROUPS.forEach(function (g) {
                        var chip = el(
                          "button",
                          "chip" + (state.fuelGroupId === g.id ? " on" : "")
                        );
                        chip.type = "button";
                        chip.appendChild(document.createTextNode(g.chip || g.title));
                        chip.appendChild(el("em", null, g.sub));
                        chip.onclick = function () {
                          setState({
                            fuelGroupId: g.id
                          });
                        };
                        row.appendChild(chip);
                      });
                      body.appendChild(row);
                      body.appendChild(
                        el(
                          "div",
                          "hint",
                          "Один тип топлива на заказ. Точное название на АЗС может отличаться (например, «ДТ ЭКО», «Дизель»)."
                        )
                      );
                      s.appendChild(body);
                      var bottom = el("div", "bottom"),
                        next = el(
                          "button",
                          "btn" + (state.loading ? " busy" : ""),
                          state.loading ? "Ищем АЗС…" : "К выбору АЗС"
                        );
                      return (
                        (next.type = "button"),
                        (next.disabled = !!state.loading),
                        state.loading || (next.onclick = loadStations),
                        bottom.appendChild(next),
                        s.appendChild(bottom),
                        s
                      );
                    })()
                  : "stations" === state.screen
                    ? (function () {
                        var s = el("div", "screen");
                        state.online || s.appendChild(el("div", "banner bad", "Нет связи"));
                        var body = el("div", "screen-body stack");
                        (body.appendChild(
                          topBack(
                            "Выбор АЗС",
                            function () {
                              setState({
                                screen: "fuel"
                              });
                            },
                            refreshIconBtn(refreshStationsAction)
                          )
                        ),
                          body.appendChild(stepsBar(1)));
                        var scroll = el("div", "scroll-body"),
                          group = fuelGroupById(state.fuelGroupId),
                          ff = el("div", "fuel-filter");
                        ff.appendChild(
                          el("b", null, "Тип топлива: " + (group.chip || group.title))
                        );
                        var ch = el("button", null, "Изменить");
                        ((ch.type = "button"),
                          (ch.onclick = function () {
                            setState({
                              screen: "fuel"
                            });
                          }),
                          ff.appendChild(ch),
                          scroll.appendChild(ff));
                        var rad = el("div", "radius");
                        rad.appendChild(el("b", null, "Радиус"));
                        var segR = el("div", "seg");
                        ([20, 40, 80].forEach(function (km) {
                          var b = el(
                            "button",
                            state.radiusKm === km ? "on" : "",
                            40 === km ? "40 км" : String(km)
                          );
                          ((b.type = "button"),
                            (b.onclick = function () {
                              setState({
                                radiusKm: km
                              });
                            }),
                            segR.appendChild(b));
                        }),
                          rad.appendChild(segR),
                          scroll.appendChild(rad));
                        var segS = el("div", "seg"),
                          bp = el("button", "price" === state.sortBy ? "on" : "", "По цене");
                        ((bp.type = "button"),
                          (bp.onclick = function () {
                            setState({
                              sortBy: "price"
                            });
                          }));
                        var bd = el(
                          "button",
                          "dist" === state.sortBy ? "on" : "",
                          "По близости"
                        );
                        ((bd.type = "button"),
                          (bd.onclick = function () {
                            setState({
                              sortBy: "dist"
                            });
                          }),
                          segS.appendChild(bp),
                          segS.appendChild(bd),
                          scroll.appendChild(segS));
                        var data = enrichedStations();
                        if (data.nearest) {
                          scroll.appendChild(el("div", "section-label", "Вы на месте?"));
                          scroll.appendChild(nearStationCard(data.nearest));
                        }
                        (scroll.appendChild(
                          el("div", "section-label", "Рекомендуем в радиусе")
                        ),
                          data.list.length
                            ? data.list.forEach(function (item) {
                                (data.nearest && item.st.id === data.nearest.st.id) ||
                                  scroll.appendChild(
                                    (function (item) {
                                      var btn = el("button", "station " + stripeClass(item.tier));
                                      btn.type = "button";
                                      var top = el("div", "row");
                                      (top.appendChild(el("span", "name", item.st.name)),
                                        top.appendChild(tierTag(item)),
                                        btn.appendChild(top));
                                      var meta = el("div", "meta");
                                      meta.appendChild(
                                        el("span", "dist", formatDist(item.dist))
                                      );
                                      meta.appendChild(stationPriceCol(item));
                                      return (
                                        btn.appendChild(meta),
                                        btn.appendChild(
                                          el("div", "muted", item.st.address || "")
                                        ),
                                        (btn.disabled = !!state.loading),
                                        state.loading ||
                                          (btn.onclick = function () {
                                            selectStation(item, false);
                                          }),
                                        btn
                                      );
                                    })(item)
                                  );
                              })
                            : scroll.appendChild(
                                el(
                                  "div",
                                  "hint",
                                  "В радиусе " +
                                    state.radiusKm +
                                    " км нет АЗС с этим топливом. Увеличьте радиус."
                                )
                              ));
                        body.appendChild(scroll);
                        s.appendChild(body);
                        return s;
                      })()
                    : "pump" === state.screen
                      ? (function () {
                          var d = state.stationDetail,
                            s = el("div", "screen"),
                            body = el("div", "screen-body");
                          if (
                            (body.appendChild(
                              topBack(d ? d.name : "Колонка", backToStations)
                            ),
                            body.appendChild(stepsBar(2)),
                            !d)
                          )
                            return (
                              body.appendChild(el("div", "muted", "Нет данных")),
                              s.appendChild(body),
                              s
                            );
                          var card = el("div", "card");
                          (card.appendChild(
                            rowMuted(
                              "Топливо",
                              (state.fuelName || "") + " · " + perLiter(state.price)
                            )
                          ),
                            card.appendChild(rowMuted("Адрес", d.address || "—")),
                            body.appendChild(card),
                            body.appendChild(el("div", "section-label", "Колонка")));
                          var grid = el("div", "grid2"),
                            code = state.fuelCode;
                          (d.pumps.forEach(function (p) {
                            var has = p.fuels.indexOf(code) >= 0,
                              status = p.status,
                              cls = "pump " + status;
                            (has || "free" !== status || ((cls = "pump off"), (status = "off")),
                              state.selectedPump === p.number && (cls += " on"));
                            var btn = el("button", cls);
                            ((btn.type = "button"),
                              btn.appendChild(
                                document.createTextNode(pumpLabel(d.brand, p.number))
                              ));
                            var em = el(
                              "em",
                              null,
                              "busy" === status
                                ? "занята"
                                : "off" === status
                                  ? "выключена / нет топлива"
                                  : "свободна"
                            );
                            (btn.appendChild(em),
                              "free" === status && has
                                ? (btn.onclick = function () {
                                    setState({
                                      selectedPump: p.number
                                    });
                                  })
                                : (btn.disabled = true),
                              grid.appendChild(btn));
                          }),
                            body.appendChild(grid),
                            "Колесо" === d.brand &&
                              body.appendChild(
                                el(
                                  "div",
                                  "hint neutral",
                                  "У «Колесо» на стойках буквы: А = 1, Б = 2, …"
                                )
                              ));
                          s.appendChild(body);
                          var bottom = el("div", "bottom"),
                            next = el("button", "btn", "К выбору объёма");
                          return (
                            (next.type = "button"),
                            (next.disabled = !state.selectedPump),
                            (next.onclick = enterVolume),
                            bottom.appendChild(next),
                            s.appendChild(bottom),
                            s
                          );
                        })()
                      : "volume" === state.screen
                        ? (function () {
                            var s = el("div", "screen"),
                              body = el("div", "screen-body");
                            (body.appendChild(
                              topBack(
                                "Сколько лить",
                                function () {
                                  setState({ screen: "pump" }, { render: false });
                                  refreshStationDetail({ keepPump: true }).then(function () {
                                    if ("pump" === state.screen) render();
                                  });
                                },
                                refreshIconBtn(refreshOrderPriceAndLimit)
                              )
                            ),
                              body.appendChild(stepsBar(3)));
                            var d = state.stationDetail,
                              card = el("div", "card");
                            (card.appendChild(
                              el(
                                "div",
                                "muted",
                                (d ? d.name : "") +
                                  " · Колонка " +
                                  pumpLabel(d && d.brand, state.selectedPump)
                              )
                            ),
                              card.appendChild(
                                rowMuted(
                                  "Цена на " + (state.fuelName || state.fuelCode || ""),
                                  perLiter(state.price)
                                )
                              ),
                              card.appendChild(
                                rowMuted(
                                  "Лимит АЗС на одну заправку",
                                  "от " +
                                    state.litersMin +
                                    " до " +
                                    state.litersMax +
                                    " л"
                                )
                              ),
                              card.appendChild(
                                rowMuted("Доступно", money(state.trip && state.trip.limitLeft))
                              ),
                              body.appendChild(card));
                            var priceN = Number(state.price) || 1,
                              leftRub = Number(state.trip && state.trip.limitLeft) || 0,
                              canAffordMin =
                                leftRub + 0.01 >= state.litersMin * priceN;
                            var bottom = el("div", "bottom");
                            if (!canAffordMin) {
                              body.appendChild(
                                el(
                                  "div",
                                  "hint",
                                  "Не хватает средств на минимальную заправку (" +
                                    state.litersMin +
                                    " л). Обратитесь к диспетчеру для увеличения лимита."
                                )
                              );
                              s.appendChild(body);
                              var homeBtn = el("button", "btn", "На главную");
                              homeBtn.type = "button";
                              homeBtn.onclick = goHome;
                              bottom.appendChild(homeBtn);
                              s.appendChild(bottom);
                              return s;
                            }
                            var vol = clampVolume(state.volume),
                              maxH = hardMaxLiters(),
                              rec = recommendedLiters(),
                              sum = Math.round(vol * state.price * 100) / 100,
                              budgetL = Math.floor(budgetRub() / priceN),
                              atCardLimit = vol >= state.litersMax && state.litersMax <= maxH,
                              atMoneyLimit = vol >= maxH && maxH < state.litersMax,
                              amountRow = el("div", "amount-row"),
                              m10 = el("button", "btn secondary", "−10");
                            ((m10.type = "button"),
                              (m10.disabled = vol <= state.litersMin),
                              (m10.onclick = function () {
                                setState({
                                  volume: clampVolume(vol - 10)
                                });
                              }),
                              amountRow.appendChild(m10));
                            var box = el("div", "amount-box");
                            var inp = document.createElement("input");
                            inp.type = "text";
                            inp.inputMode = "numeric";
                            inp.pattern = "[0-9]*";
                            inp.className = "vol-input";
                            inp.value = String(Math.round(vol));
                            inp.setAttribute("aria-label", "Объём в литрах");
                            inp.addEventListener("change", function () {
                              var n = parseInt(inp.value.replace(/\D/g, ""), 10);
                              setState({
                                volume: clampVolume(isNaN(n) ? state.litersMin : n)
                              });
                            });
                            inp.addEventListener("keydown", function (e) {
                              if (e.key === "Enter") {
                                inp.blur();
                              }
                            });
                            box.appendChild(inp);
                            box.appendChild(el("div", "vol-unit", "л"));
                            (box.appendChild(el("div", "sum", "≈ " + money(sum))),
                              amountRow.appendChild(box));
                            var p10 = el("button", "btn secondary", "+10");
                            ((p10.type = "button"),
                              (p10.disabled = vol >= maxH),
                              (p10.onclick = function () {
                                setState({
                                  volume: clampVolume(vol + 10)
                                });
                              }),
                              amountRow.appendChild(p10),
                              body.appendChild(amountRow));
                            var step = el("div", "stepper"),
                              m50 = el("button", "btn secondary", "−50");
                            ((m50.type = "button"),
                              (m50.disabled = vol <= state.litersMin),
                              (m50.onclick = function () {
                                setState({
                                  volume: clampVolume(vol - 50)
                                });
                              }));
                            var p50 = el("button", "btn secondary", "+50");
                            ((p50.type = "button"),
                              (p50.disabled = vol >= maxH),
                              (p50.onclick = function () {
                                setState({
                                  volume: clampVolume(vol + 50)
                                });
                              }),
                              step.appendChild(m50),
                              step.appendChild(p50),
                              body.appendChild(step));
                            var recRow = el("div", "rec-row");
                            var recBtn = el(
                              "button",
                              "btn recommend" + (vol === rec ? " on" : ""),
                              "Рекомендовано: " + rec + " л"
                            );
                            ((recBtn.type = "button"),
                              (recBtn.onclick = function () {
                                setState({
                                  volume: rec
                                });
                              }));
                            var help = el("button", "help", "?");
                            ((help.type = "button"),
                              (help.onclick = function () {
                                setState({
                                  sheet: "budgetHelp"
                                });
                              }));
                            (recRow.appendChild(recBtn),
                              recRow.appendChild(help),
                              body.appendChild(recRow));
                            if (vol <= state.litersMin) {
                              body.appendChild(
                                el(
                                  "div",
                                  "hint",
                                  "Меньше " + state.litersMin + " л нельзя"
                                )
                              );
                            } else if (atCardLimit) {
                              body.appendChild(
                                el(
                                  "div",
                                  "hint",
                                  "Лимит на одну заправку — " +
                                    state.litersMax +
                                    " литров. Нужно больше? Оформите ещё один заказ."
                                )
                              );
                            } else if (atMoneyLimit) {
                              body.appendChild(
                                el(
                                  "div",
                                  "hint",
                                  "Больше нельзя: доступно " +
                                    money(state.trip.limitLeft) +
                                    "."
                                )
                              );
                            }
                            if (
                              sum > budgetRub() + 0.01 &&
                              !(vol <= state.litersMin && state.litersMin > budgetL)
                            ) {
                              body.appendChild(
                                el(
                                  "div",
                                  "tip-save",
                                  "Выгоднее оставить запас на рейс. При сбое холд может вернуться не сразу."
                                )
                              );
                            }
                            s.appendChild(body);
                            var next = el(
                              "button",
                              "btn" + (state.loading ? " busy" : ""),
                              state.loading
                                ? "Обновляем…"
                                : "К подтверждению · " + vol + " л"
                            );
                            return (
                              (next.type = "button"),
                              (next.disabled = !!state.loading),
                              state.loading ||
                                (next.onclick = function () {
                                  setState({
                                    volume: vol,
                                    clientRequestId: null,
                                    screen: "confirm",
                                    sending: false
                                  });
                                }),
                              bottom.appendChild(next),
                              s.appendChild(bottom),
                              s
                            );
                          })()
                        : "confirm" === state.screen
                          ? (function () {
                              var s = el("div", "screen");
                              state.online ||
                                s.appendChild(el("div", "banner bad", "Нет связи"));
                              var body = el("div", "screen-body");
                              (body.appendChild(
                                topBack(
                                  "Проверьте заказ",
                                  function () {
                                    state.sending ||
                                      setState({
                                        screen: "volume"
                                      });
                                  },
                                  refreshIconBtn(refreshOrderPriceAndLimit)
                                )
                              ),
                                body.appendChild(stepsBar(4)));
                              var d = state.stationDetail,
                                card = el("div", "card summary");

                              function addRow(a, b) {
                                var r = el("div", "row");
                                (r.appendChild(el("span", null, a)),
                                  r.appendChild(el("span", null, b)),
                                  card.appendChild(r));
                              }
                              (addRow("АЗС", d ? d.name : "—"),
                                addRow("Колонка", pumpLabel(d && d.brand, state.selectedPump)),
                                addRow("Топливо", state.fuelName || state.fuelCode),
                                addRow("Объём", state.volume + " л"),
                                addRow("Цена", perLiter(state.price)),
                                addRow(
                                  "В холд",
                                  money(Math.round(state.volume * state.price * 100) / 100)
                                ),
                                addRow(
                                  "Доступно",
                                  money(state.trip && state.trip.limitLeft)
                                ),
                                body.appendChild(card),
                                body.appendChild(
                                  el(
                                    "div",
                                    "hint",
                                    state.sending
                                      ? "Отправляем заказ… Не нажимайте снова."
                                      : "В момент заказа мы проверим актуальную цену АЗС. Об изменениях сразу сообщим"
                                  )
                                ),
                                s.appendChild(body));
                              var bottom = el("div", "bottom"),
                                busyOrder = !!state.sending || !!state.loading,
                                go = el(
                                  "button",
                                  "btn" +
                                    (state.sending ? " sending" : "") +
                                    (state.loading ? " busy" : ""),
                                  state.sending
                                    ? "Отправляем…"
                                    : state.loading
                                      ? "Обновляем…"
                                      : "Заправить · " +
                                          money(
                                            Math.round(state.volume * state.price * 100) / 100
                                          )
                                );
                              ((go.type = "button"),
                                (go.disabled = busyOrder),
                                busyOrder || (go.onclick = submitFueling));
                              if ((bottom.appendChild(go), !busyOrder)) {
                                var back = el("button", "btn ghost", "Назад");
                                ((back.type = "button"),
                                  (back.onclick = function () {
                                    setState({
                                      screen: "volume"
                                    });
                                  }),
                                  bottom.appendChild(back));
                              }
                              return (s.appendChild(bottom), s);
                            })()
                          : "process" === state.screen
                            ? (function () {
                                var f = state.fueling,
                                  s = el("div", "screen");
                                if (state.linkOkBanner) {
                                  s.appendChild(el("div", "banner ok", state.linkOkBanner));
                                } else if (!state.online) {
                                  s.appendChild(
                                    el(
                                      "div",
                                      "banner bad",
                                      "Нет связи · налив на АЗС продолжается, цифры догонят"
                                    )
                                  );
                                } else if (false === navigator.onLine) {
                                  s.appendChild(el("div", "banner warn", "Связь слабая"));
                                }
                                var body = el("div", "screen-body");
                                if ((body.appendChild(stepsBar(4)), !f))
                                  return (
                                    body.appendChild(el("div", "muted", "Нет данных заправки")),
                                    s.appendChild(body),
                                    s
                                  );
                                var center = el("div", "center");
                                function formatClock(totalSec) {
                                  var sec = Math.max(0, Math.floor(totalSec)),
                                    mm = String(Math.floor(sec / 60)),
                                    ss = String(sec % 60);
                                  if (ss.length < 2) ss = "0" + ss;
                                  return mm + ":" + ss;
                                }
                                var elapsed =
                                  (Date.now() - (f.createdAt || Date.now())) / 1e3;
                                if ("accepted" === f.status) {
                                  // Долгое ожидание подтверждения АЗС (в бою — часы; в FakeApi — до STATION_NO_RESPONSE).
                                  center.appendChild(
                                    el("div", "big", "Ждём подтверждение АЗС")
                                  );
                                  if (state.online) {
                                    center.appendChild(el("div", "timer", formatClock(elapsed)));
                                    center.appendChild(
                                      el("div", "timer-label", "с момента заказа · холд занят")
                                    );
                                  } else {
                                    center.appendChild(el("div", "timer", "—:—"));
                                    center.appendChild(
                                      el("div", "timer-label", "время обновим при сети")
                                    );
                                  }
                                  center.appendChild(
                                    el(
                                      "div",
                                      "hint",
                                      "Пока АЗС не ответила, отмена доступна. Новый заказ лучше не создавать — будет второй холд."
                                    )
                                  );
                                  var cardAcc = el("div", "card wide");
                                  cardAcc.appendChild(
                                    rowMuted(
                                      "Колонка",
                                      pumpLabel(
                                        state.stationDetail && state.stationDetail.brand,
                                        f.pump
                                      )
                                    )
                                  );
                                  cardAcc.appendChild(rowMuted("В холде", money(f.amountHeld)));
                                  center.appendChild(cardAcc);
                                } else if ("waiting_nozzle" === f.status) {
                                  var wrapNozzle = fromTemplate("tpl-nozzle");
                                  if (wrapNozzle) center.appendChild(wrapNozzle);
                                  center.appendChild(el("div", "big", "Вставьте пистолет"));
                                  var leftNozzle = Math.max(0, Math.ceil(60 - elapsed));
                                  if (state.online) {
                                    center.appendChild(
                                      el("div", "timer", formatClock(leftNozzle))
                                    );
                                    center.appendChild(
                                      el(
                                        "div",
                                        "timer-label",
                                        "до отмены, если пистолет не вставлен"
                                      )
                                    );
                                  } else {
                                    center.appendChild(el("div", "timer", "—:—"));
                                    center.appendChild(
                                      el("div", "timer-label", "таймер обновим при сети")
                                    );
                                  }
                                  var cardWait = el("div", "card wide");
                                  cardWait.appendChild(
                                    rowMuted(
                                      "Колонка",
                                      pumpLabel(
                                        state.stationDetail && state.stationDetail.brand,
                                        f.pump
                                      )
                                    )
                                  );
                                  cardWait.appendChild(
                                    rowMuted("В холде", money(f.amountHeld))
                                  );
                                  center.appendChild(cardWait);
                                } else if ("fueling" === f.status) {
                                  center.appendChild(el("div", "muted", "Идёт налив"));
                                  var live = el("div", "live-wrap");
                                  (live.appendChild(
                                    el("span", "live", litersStr(f.currentLiters || 0))
                                  ),
                                    live.appendChild(
                                      el("span", "live-max", "/ " + litersStr(f.liters) + " л")
                                    ),
                                    center.appendChild(live));
                                  var pct = f.liters
                                      ? Math.min(
                                          100,
                                          Math.round(((f.currentLiters || 0) / f.liters) * 100)
                                        )
                                      : 0,
                                    prog = el("div", "progress lg"),
                                    fi = el("i");
                                  (setProgress(fi, pct),
                                    prog.appendChild(fi),
                                    center.appendChild(prog));
                                  var card2 = el("div", "card");
                                  ((card2.className = "card wide"),
                                    card2.appendChild(
                                      rowMuted(
                                        "Сейчас",
                                        "≈ " +
                                          money(
                                            Math.round((f.currentLiters || 0) * f.price * 100) /
                                              100
                                          )
                                      )
                                    ),
                                    card2.appendChild(rowMuted("В холде", money(f.amountHeld))),
                                    center.appendChild(card2),
                                    center.appendChild(
                                      el(
                                        "div",
                                        "hint",
                                        "Теперь отменить можно только осторожным отключением пистолета. Новый заказ не создавайте."
                                      )
                                    ));
                                }
                                (body.appendChild(center), s.appendChild(body));
                                var bottom = el("div", "bottom");
                                if ("accepted" === f.status || "waiting_nozzle" === f.status) {
                                  var cancel = el(
                                    "button",
                                    "btn danger" + (state.sending ? " busy" : ""),
                                    state.sending
                                      ? "Отменяем…"
                                      : state.online
                                        ? "Отменить заказ"
                                        : "Отменить · нет сети"
                                  );
                                  if (
                                    ((cancel.type = "button"),
                                    (cancel.disabled = !state.online || state.sending),
                                    state.sending || (cancel.onclick = cancelFueling),
                                    bottom.appendChild(cancel),
                                    !state.online && !state.sending)
                                  ) {
                                    var up = el("button", "btn secondary", "Обновить статус");
                                    ((up.type = "button"),
                                      (up.onclick = function () {
                                        f.id && startPolling(f.id);
                                      }),
                                      bottom.appendChild(up));
                                  }
                                } else {
                                  var dis = el("button", "btn secondary", "Отмена недоступна");
                                  if (
                                    ((dis.type = "button"),
                                    (dis.disabled = true),
                                    bottom.appendChild(dis),
                                    !state.online)
                                  ) {
                                    var up2 = el("button", "btn secondary", "Обновить статус");
                                    ((up2.type = "button"),
                                      (up2.onclick = function () {
                                        f.id && startPolling(f.id);
                                      }),
                                      bottom.appendChild(up2));
                                  }
                                }
                                return (s.appendChild(bottom), s);
                              })()
                            : "result" === state.screen
                              ? (function () {
                                  var f = state.lastFueling || state.fueling,
                                    s = el("div", "screen"),
                                    body = el("div", "screen-body"),
                                    center = el("div", "center"),
                                    ok = f && "completed" === f.status;
                                  (center.appendChild(
                                    el("div", ok ? "okicon" : "badicon", ok ? "✓" : "×")
                                  ),
                                    center.appendChild(
                                      el(
                                        "div",
                                        "big",
                                        ok ? "Заправка завершена" : "Заправка не удалась"
                                      )
                                    ));
                                  var card = el("div", "card summary");

                                  function addRow(a, b) {
                                    var r = el("div", "row");
                                    (r.appendChild(el("span", null, a)),
                                      r.appendChild(el("span", null, b)),
                                      card.appendChild(r));
                                  }
                                  ((card.className = "card wide"),
                                    f &&
                                      (addRow("АЗС", f.stationName || "—"),
                                      ok
                                        ? (addRow("Залито", litersStr(f.factLiters) + " л"),
                                          addRow("Списано", money(f.factAmount)))
                                        : (addRow("Причина", reasonLabel(f.reason)),
                                          addRow("Холд", "возвращён")),
                                      addRow(
                                        "Остаток лимита",
                                        money(state.trip && state.trip.limitLeft)
                                      )));
                                  (center.appendChild(card),
                                    ok &&
                                      center.appendChild(
                                        el(
                                          "div",
                                          "muted",
                                          "Чек у диспетчера — в приложении его нет"
                                        )
                                      ));
                                  (body.appendChild(center), s.appendChild(body));
                                  var bottom = el("div", "bottom"),
                                    home = el("button", "btn", "На главную");
                                  if (
                                    ((home.type = "button"),
                                    (home.onclick = goHome),
                                    bottom.appendChild(home),
                                    ok)
                                  ) {
                                    var again = el(
                                      "button",
                                      "btn secondary",
                                      "Заправить ещё · другой бак"
                                    );
                                    ((again.type = "button"),
                                      (again.onclick = function () {
                                        (resetOrder(false),
                                          setState({
                                            screen: "fuel",
                                            overlay: null
                                          }));
                                      }),
                                      bottom.appendChild(again));
                                  } else {
                                    var retry = el("button", "btn secondary", "Заказать снова");
                                    ((retry.type = "button"),
                                      (retry.onclick = function () {
                                        setState({
                                          screen: "volume",
                                          clientRequestId: null,
                                          fueling: null,
                                          lastFueling: null
                                        });
                                      }),
                                      bottom.appendChild(retry));
                                  }
                                  return (s.appendChild(bottom), s);
                                })()
                              : "net" === state.screen
                                ? (function () {
                                    var kind = state.netScreen || "afterStart",
                                      s = el("div", "screen");
                                    s.appendChild(
                                      el("div", "banner bad", "Нет связи с сервером")
                                    );
                                    var body = el("div", "screen-body"),
                                      center = el("div", "center");
                                    center.appendChild(el("div", "warnicon", "!"));
                                    var title = "Нет связи",
                                      text = "";
                                    "stations" === kind
                                      ? ((title = "Нет связи с сервером"),
                                        (text =
                                          "Список АЗС не загрузился. Заказ ещё не создавался — холда нет."))
                                      : "beforeStart" === kind
                                        ? ((title = "Запрос не дошёл"),
                                          (text =
                                            "Активной заправки нет. Можно повторить с тем же id — второго холда не будет."))
                                        : "afterStart" === kind
                                          ? ((title = "Нет ответа сервера"),
                                            (text =
                                              "Заказ мог уже уйти на АЗС. Не создавайте новый — будет второй холд. Если колонка загудит — вставьте пистолет в течение 60 секунд от этого момента."))
                                          : "cancel" === kind &&
                                            ((title = "Отмена не отправилась"),
                                            (text =
                                              "Заказ на АЗС мог остаться активным. Не оформляйте новый — проверьте статус."));
                                    if (
                                      (center.appendChild(el("div", "big", title)),
                                      center.appendChild(el("div", "muted", text)),
                                      state.pending && state.pending.clientRequestId)
                                    ) {
                                      var card = el("div", "card");
                                      ((card.className = "card wide"),
                                        card.appendChild(
                                          el("div", "muted sm", "Сохранён id запроса")
                                        ),
                                        card.appendChild(
                                          el("div", "muted", state.pending.clientRequestId)
                                        ),
                                        center.appendChild(card));
                                    }
                                    (body.appendChild(center), s.appendChild(body));
                                    var bottom = el("div", "bottom");
                                    if ("stations" === kind) {
                                      var r = el("button", "btn", "Повторить");
                                      ((r.type = "button"),
                                        (r.onclick = loadStations),
                                        bottom.appendChild(r));
                                      var h = el("button", "btn secondary", "На главную");
                                      ((h.type = "button"),
                                        (h.onclick = goHome),
                                        bottom.appendChild(h));
                                    } else if ("afterStart" === kind || "cancel" === kind) {
                                      var c = el("button", "btn", "Проверить статус");
                                      ((c.type = "button"),
                                        (c.onclick = checkActiveAfterNet),
                                        bottom.appendChild(c));
                                      if ("afterStart" === kind) {
                                        var t = el(
                                          "button",
                                          "btn secondary",
                                          "Повторить тот же заказ"
                                        );
                                        ((t.type = "button"),
                                          (t.onclick = retrySameOrder),
                                          bottom.appendChild(t));
                                      }
                                      var cl = el("button", "btn ghost", "Закрыть");
                                      ((cl.type = "button"),
                                        (cl.onclick = goHome),
                                        bottom.appendChild(cl));
                                    } else if ("beforeStart" === kind) {
                                      var t2 = el("button", "btn", "Повторить тот же заказ");
                                      ((t2.type = "button"),
                                        (t2.onclick = retrySameOrder),
                                        bottom.appendChild(t2));
                                      var c2 = el(
                                        "button",
                                        "btn secondary",
                                        "Проверить активную заправку"
                                      );
                                      ((c2.type = "button"),
                                        (c2.onclick = checkActiveAfterNet),
                                        bottom.appendChild(c2));
                                    }
                                    return (s.appendChild(bottom), s);
                                  })()
                                : viewHome()),
      root.appendChild(view),
      "hold" === state.overlay &&
        root.appendChild(
          (function () {
            var wrap = el("div", "overlay");
            wrap.onclick = function (e) {
              e.target === wrap &&
                setState({
                  overlay: null
                });
            };
            var sheet = el("div", "sheet");
            (sheet.appendChild(el("h3", null, "Что такое холд")),
              sheet.appendChild(
                el(
                  "div",
                  "muted copy",
                  "Холд — сумма, которая временно блокируется на лимите в момент заказа до получения подтверждения от АЗС. Пока деньги в холде, потратить их нельзя."
                )
              ),
              sheet.appendChild(
                el(
                  "div",
                  "muted copy",
                  "После подтверждения АЗС заправки списывается только стоимость фактически залитого топлива, остаток холда возвращается."
                )
              ),
              sheet.appendChild(
                el(
                  "div",
                  "muted copy",
                  "Если заправка не прошла — холд возвращается."
                )
              ));
            var ok = el("button", "btn", "Понятно");
            return (
              (ok.type = "button"),
              (ok.onclick = function () {
                setState({
                  overlay: null
                });
              }),
              sheet.appendChild(ok),
              wrap.appendChild(sheet),
              wrap
            );
          })()
        ),
      "tripChanged" === state.overlay &&
        root.appendChild(
          (function () {
            var wrap = el("div", "overlay");
            var sheet = el("div", "sheet");
            sheet.appendChild(el("h3", null, "Новый рейс"));
            sheet.appendChild(
              el(
                "div",
                "muted",
                "Данные рейса обновились. История и незавершённый заказ на устройстве сброшены — вы на главном экране."
              )
            );
            if (state.trip) {
              var card = el("div", "card");
              card.appendChild(
                el("div", "route", state.trip.from + " → " + state.trip.to)
              );
              card.appendChild(
                rowMuted("Доступно", money(state.trip.limitLeft))
              );
              sheet.appendChild(card);
            }
            var ok = el("button", "btn", "Понятно");
            ok.type = "button";
            ok.onclick = function () {
              setState({ overlay: null, screen: "home" });
            };
            sheet.appendChild(ok);
            wrap.appendChild(sheet);
            return wrap;
          })()
        ),
      state.sheet &&
        root.appendChild(
          (function () {
            var wrap = el("div", "overlay");
            wrap.onclick = function (e) {
              e.target === wrap &&
                setState({
                  sheet: null,
                  sheetData: null
                });
            };
            var sheet = el("div", "sheet"),
              kind = state.sheet,
              data = state.sheetData;
            if ("expensive" === kind) {
              sheet.appendChild(el("h3", null, "Не упустите выгодную АЗС"));
              var cmp = el("div", "card cmp");
              function cmpOffer(lblClass, lbl, priceClass, price, it) {
                var block = el("div", "cmp-offer");
                var left = el("div", "cmp-left");
                left.appendChild(el("div", lblClass, lbl));
                left.appendChild(
                  el(
                    "div",
                    "muted sm",
                    it.st.name + " · " + formatDist(it.dist)
                  )
                );
                block.appendChild(left);
                block.appendChild(el("div", priceClass, perLiter(price)));
                return block;
              }
              // Название под «Выбрано»/«Выгоднее», в левой колонке — не залезает под цену.
              cmp.appendChild(
                cmpOffer(
                  "lbl-dear",
                  "Выбрано",
                  "price-dear",
                  data.item.price,
                  data.item
                )
              );
              if (data.better) {
                cmp.appendChild(
                  cmpOffer(
                    "lbl-good",
                    "Выгоднее",
                    "price-good",
                    data.better.price,
                    data.better
                  )
                );
              }
              sheet.appendChild(cmp);
              if (data.better) {
                var toBetter = el("button", "btn", "К выгодной АЗС");
                toBetter.type = "button";
                toBetter.onclick = function () {
                  selectStation(data.better, true);
                };
                sheet.appendChild(toBetter);
              }
              var anyway = el("button", "btn secondary dear-go", "К дорогой АЗС");
              anyway.type = "button";
              anyway.onclick = function () {
                selectStation(data.item, true);
              };
              sheet.appendChild(anyway);
              var backList = el("button", "btn ghost", "К списку АЗС");
              backList.type = "button";
              backList.onclick = backToStations;
              sheet.appendChild(backList);
            } else if ("priceChanged" === kind) {
              (sheet.appendChild(el("h3", null, "Цена изменилась")),
                sheet.appendChild(
                  el("div", "muted", "Старый заказ не прошёл — холд не создан.")
                ));
              var card = el("div", "card");
              (card.appendChild(rowMuted("Было", perLiter(data.oldPrice))),
                card.appendChild(rowMuted("Стало", perLiter(data.newPrice))),
                sheet.appendChild(card));
              var acc = el("button", "btn", "Принять " + perLiter(data.newPrice));
              ((acc.type = "button"),
                (acc.onclick = function () {
                  setState({
                    price: data.newPrice,
                    sheet: null,
                    sheetData: null,
                    screen: "confirm",
                    clientRequestId: null
                  });
                }));
              var other = el("button", "btn secondary", "Другая АЗС");
              other.type = "button";
              other.onclick = backToStations;
              sheet.appendChild(acc);
              sheet.appendChild(other);
            } else if ("pumpBusy" === kind) {
              (sheet.appendChild(el("h3", null, "Колонка занята")),
                sheet.appendChild(
                  el("div", "muted", "Холд не создан. Выберите другую колонку.")
                ));
              var pick = el("button", "btn", "К колонкам");
              pick.type = "button";
              pick.onclick = function () {
                setState({ sheet: null, screen: "pump" }, { render: false });
                refreshStationDetail({ keepPump: false }).then(function () {
                  render();
                });
              };
              sheet.appendChild(pick);
            } else if ("budgetHelp" === kind) {
              var leftB = Number(state.trip && state.trip.limitLeft) || 0,
                totB = tripLimitTotal();
              (sheet.appendChild(el("h3", null, "Рекомендуемый расход")),
                sheet.appendChild(
                  el(
                    "div",
                    "muted copy",
                    "Два мягких лимита: 50% от остатка (" +
                      money(Math.round(0.5 * leftB)) +
                      ") и 30% от лимита рейса (" +
                      money(Math.round(0.3 * totB)) +
                      "). Рекомендуем меньший: " +
                      money(budgetRub()) +
                      "."
                  )
                ),
                sheet.appendChild(
                  el(
                    "div",
                    "muted copy",
                    "«Рекомендовано» подставляет объём по этому бюджету, не выше лимита АЗС и доступных денег."
                  )
                ),
                sheet.appendChild(
                  el(
                    "div",
                    "muted copy",
                    "Выше бюджета можно. Выше доступного или лимита АЗС — нельзя. Меньше " +
                      state.litersMin +
                      " л — тоже нельзя."
                  )
                ));
              var ok = el("button", "btn", "Понятно");
              ((ok.type = "button"),
                (ok.onclick = function () {
                  setState({
                    sheet: null
                  });
                }),
                sheet.appendChild(ok));
            } else if ("limit" === kind) {
              (sheet.appendChild(el("h3", null, "Не хватает лимита")),
                sheet.appendChild(
                  el("div", "muted", "Доступно: " + money(data && data.available))
                ));
              var back = el("button", "btn", "Изменить объём");
              ((back.type = "button"),
                (back.onclick = function () {
                  setState({
                    sheet: null,
                    screen: "volume"
                  });
                }),
                sheet.appendChild(back));
            } else if ("cannotCancel" === kind) {
              (sheet.appendChild(el("h3", null, "Отменить нельзя")),
                sheet.appendChild(
                  el("div", "muted", "Налив уже начался или заправка завершена.")
                ));
              var ok2 = el("button", "btn", "Понятно");
              ((ok2.type = "button"),
                (ok2.onclick = function () {
                  setState({
                    sheet: null
                  });
                }),
                sheet.appendChild(ok2));
            } else {
              (sheet.appendChild(el("h3", null, "Ошибка")),
                sheet.appendChild(
                  el("div", "muted", (data && data.message) || "Что-то пошло не так")
                ));
              var ok3 = el("button", "btn", "Закрыть");
              ((ok3.type = "button"),
                (ok3.onclick = function () {
                  setState({
                    sheet: null
                  });
                }),
                sheet.appendChild(ok3));
            }
            return (wrap.appendChild(sheet), wrap);
          })()
        ));
  }

  /* ========== shared UI bits ========== */
  function stepsBar(activeIdx) {
    var wrap = el("div", "steps");
    return (
      ["Топливо", "АЗС", "Колонка", "Объём", "Налив"].forEach(function (lab, i) {
        var cls = "s";
        (i < activeIdx && (cls += " done"),
          i === activeIdx && (cls += " now"),
          wrap.appendChild(el("span", cls, lab)));
      }),
      wrap
    );
  }

  function refreshIconBtn(onClick) {
    var busy = !!state.loading || !!state.sending;
    var b = el("button", "icon-refresh");
    b.type = "button";
    b.setAttribute("aria-label", busy ? "Обновляем…" : "Обновить");
    b.disabled = busy;
    if (busy) b.appendChild(el("div", "spinner"));
    else b.appendChild(document.createTextNode("↻"));
    b.onclick = function () {
      if (state.loading || state.sending) return;
      onClick();
    };
    return b;
  }

  function topBack(title, onBack, rightEl) {
    var bar = el("div", "topbar"),
      b = el("button", "help", "←");
    b.type = "button";
    b.onclick = onBack;
    bar.appendChild(b);
    bar.appendChild(el("h2", null, title));
    if (rightEl) bar.appendChild(rightEl);
    return bar;
  }

  function stationPriceCol(item) {
    var col = el("div", "price-col");
    col.appendChild(
      el("div", "fuel-lab", fuelDisplayName(item.st.brand, item.code))
    );
    col.appendChild(
      el("span", "price " + priceTierClass(item.tier), perLiter(item.price))
    );
    return col;
  }

  function refreshStationsAction() {
    if (state.loading) return;
    setState({ loading: true, error: null });
    callApi("getTrip")
      .then(function (trip) {
        var ch = applyTrip(trip);
        if (ch) {
          setState({
            loading: false,
            trip: trip,
            tripFromCache: false,
            screen: "home",
            overlay: "tripChanged"
          });
          return;
        }
        setState({ trip: trip, tripFromCache: false }, { render: false });
        loadStations({ force: true });
      })
      .catch(function () {
        loadStations({ force: true });
      });
  }

  function rowMuted(a, b) {
    var r = el("div", "row mt-sm");
    r.appendChild(el("span", "muted", a));
    r.appendChild(el("span", null, b));
    return r;
  }

  /* ========== home screen ========== */
  function knownHoldRub() {
    var seen = {};
    var sum = 0;
    state.history.forEach(function (h) {
      if (!h.active || !h.fuelingId || seen[h.fuelingId]) return;
      seen[h.fuelingId] = true;
      sum += Number(h.amountHeld) || 0;
    });
    var af = state.activeFueling;
    if (af && af.id && !seen[af.id]) sum += Number(af.amountHeld) || 0;
    return sum;
  }

  function viewHome() {
    var s = el("div", "screen");
    (state.online && !state.tripFromCache) ||
      s.appendChild(
        el(
          "div",
          "banner bad",
          state.tripFromCache ? "Нет связи · показаны последние данные" : "Нет связи"
        )
      );
    var body = el("div", "screen-body");
    var homeTop = el("div", "topbar");
    homeTop.appendChild(el("h1", "title", "Заправка в рейсе"));
    homeTop.appendChild(refreshIconBtn(refreshHome));
    body.appendChild(homeTop);
    if (!state.trip) {
      (body.appendChild(el("div", "card muted", "Не удалось загрузить рейс.")),
        s.appendChild(body),
        s.appendChild(el("div", "bottom")));
      return s;
    }
    var trip = state.trip,
      cardTrip = el("div", "card");
    (cardTrip.appendChild(
      el(
        "div",
        "muted",
        "Текущий рейс · " +
          (function (iso) {
            if (!iso) return "";
            var p = String(iso).split("-");
            return 3 !== p.length
              ? iso
              : Number(p[2]) +
                  " " +
                  [
                    "января",
                    "февраля",
                    "марта",
                    "апреля",
                    "мая",
                    "июня",
                    "июля",
                    "августа",
                    "сентября",
                    "октября",
                    "ноября",
                    "декабря"
                  ][Number(p[1]) - 1];
          })(trip.date)
      )
    ),
      cardTrip.appendChild(el("div", "route", trip.from + " → " + trip.to)),
      cardTrip.appendChild(el("div", "muted", "Тягач " + trip.truck)),
      body.appendChild(cardTrip));
    var left = Number(trip.limitLeft) || 0,
      total = tripLimitTotal(),
      holdAmt = knownHoldRub(),
      leftPct =
        total > 0 ? Math.max(0, Math.min(100, Math.round((100 * left) / total))) : 0,
      holdPct =
        total > 0 ? Math.max(0, Math.min(100 - leftPct, Math.round((100 * holdAmt) / total))) : 0,
      cardLimit = el("div", "card");
    (cardLimit.appendChild(
      el("div", "muted", state.tripFromCache ? "Доступно · кэш" : "Доступно сейчас")
    ),
      cardLimit.appendChild(el("div", "limit", money(left))),
      cardLimit.appendChild(el("div", "muted", "из " + money(total) + " на рейс")));
    var bar = el("div", "progress stacked");
    var availSeg = el("span", "seg-avail");
    availSeg.style.width = leftPct + "%";
    bar.appendChild(availSeg);
    if (holdPct > 0) {
      var holdSeg = el("span", "seg-hold");
      holdSeg.style.width = holdPct + "%";
      holdSeg.title = "В холде " + money(holdAmt);
      bar.appendChild(holdSeg);
    }
    cardLimit.appendChild(bar);
    if (holdPct > 0) {
      cardLimit.appendChild(
        el("div", "muted sm", "Тёмно-серый участок — активный холд " + money(holdAmt))
      );
    }
    body.appendChild(cardLimit);
    var holdLine = el("div", "hold-line");
    holdLine.appendChild(el("span", "muted", "Часть суммы может быть в холде"));
    var holdBtn = el("button", "hold-link", "Что такое холд?");
    ((holdBtn.type = "button"),
      (holdBtn.onclick = function () {
        setState({
          overlay: "hold"
        });
      }),
      holdLine.appendChild(holdBtn),
      body.appendChild(holdLine));
    var hist = el("div", "hist");
    var shownId = state.activeFueling && state.activeFueling.id;
    var otherActive = state.history.filter(function (h) {
      return h.active && h.fuelingId && h.fuelingId !== shownId;
    });
    var activeCount = (state.activeFueling ? 1 : 0) + otherActive.length;
    if (activeCount) {
      body.appendChild(
        el(
          "div",
          "section-label",
          activeCount > 1 ? "Активные заправки" : "Активная заправка"
        )
      );
      if (state.activeFueling) hist.appendChild(activeFuelingCard(state.activeFueling, false));
      otherActive.forEach(function (h) {
        hist.appendChild(histRow(h, false));
      });
    } else {
      body.appendChild(el("div", "section-label", "Последняя заправка"));
      var last = state.history[0];
      if (last) hist.appendChild(histRow(last, false));
      else
        hist.appendChild(
          el("div", "hist-item muted", "Пока пусто — появятся после заказов")
        );
    }
    body.appendChild(hist);
    var all = el("button", "linkish", "Вся история →");
    ((all.type = "button"),
      (all.onclick = function () {
        setState({ screen: "history", overlay: null });
        if (state.online) {
          callApi("getActiveFueling")
            .then(function (f) {
              if (f) ensureHistoryForActive(f);
              return reconcileOpenHistory().then(function () {
                if ("history" === state.screen) {
                  setState({ activeFueling: f || null });
                }
              });
            })
            .catch(function () {});
        }
      }),
      body.appendChild(all),
      s.appendChild(body));
    var bottom = el("div", "bottom");
    var busy = !!state.loading;
    var go = el(
      "button",
      "btn" + (busy ? " busy" : ""),
      busy ? "Загрузка…" : "Заправиться"
    );
    return (
      (go.type = "button"),
      (go.disabled = busy || !state.online || state.tripFromCache),
      busy || (go.onclick = onStartFueling),
      bottom.appendChild(go),
      s.appendChild(bottom),
      s
    );
  }

  /* ========== history row / station tags / nearest card ========== */
  function histFormula(h) {
    var lit = h.ok
      ? h.factLiters != null
        ? h.factLiters
        : h.liters
      : h.orderedLiters != null
        ? h.orderedLiters
        : h.liters;
    var price = h.price;
    var sum = h.ok ? h.factAmount : h.amountHeld != null ? h.amountHeld : h.factAmount;
    if (lit == null || price == null || sum == null) return null;
    return {
      head:
        litersStr(lit) +
        " л × " +
        perLiter(price).replace(" ₽/л", "") +
        " ₽/л = ",
      sum: money(sum)
    };
  }

  function appendHistFormulaRow(item, label, h) {
    var row = el("div", "row mt-sm");
    row.appendChild(el("span", "muted", label));
    var val = el("span", "hist-formula");
    var formula = histFormula(h);
    if (formula) {
      val.appendChild(document.createTextNode(formula.head));
      val.appendChild(el("span", "hist-sum", formula.sum));
    } else {
      val.appendChild(
        el(
          "span",
          "hist-sum",
          money(h.ok ? h.factAmount : h.amountHeld != null ? h.amountHeld : h.factAmount)
        )
      );
    }
    row.appendChild(val);
    item.appendChild(row);
  }

  function appendHistUnderfillRows(item, h, withRefund) {
    appendHistFormulaRow(item, "Списано", h);
    if (false === withRefund) return;
    var refund = holdRefundAmount(h);
    if (refund > 0.009) {
      item.appendChild(rowMuted("Возврат холда", money(refund)));
    }
  }

  function fuelingStatusLabel(st) {
    return (
      {
        accepted: "Принят",
        waiting_nozzle: "Ожидание пистолета",
        fueling: "Налив",
        completed: "Завершена",
        cancelled: "Отменена"
      }[st] || "Холд"
    );
  }

  function histWhenReasonLine(h) {
    var parts = [];
    if (h.whenLabel) parts.push(h.whenLabel);
    if (h.reason) parts.push(h.reason);
    return parts.length ? parts.join(" · ") : "";
  }

  function histFuelPumpLine(h) {
    var parts = [];
    if (h.fuelName) parts.push(h.fuelName);
    if (h.pumpLabel) parts.push(h.pumpLabel);
    else if (h.pump != null) parts.push(String(h.pump));
    return parts.length ? parts.join(" · ") : "";
  }

  function appendHistHead(item, whenText, statusClass, statusText, stationName) {
    var head = el("div", "top");
    head.appendChild(el("span", "muted sm", whenText || "—"));
    head.appendChild(el("span", statusClass, statusText));
    item.appendChild(head);
    item.appendChild(el("div", "name", stationName || "АЗС"));
  }

  function activeFuelingCard(f, withDetails) {
    var item = el("div", "hist-item active-fuel");
    var histEntry = null;
    state.history.forEach(function (h) {
      if (h.fuelingId === f.id) histEntry = h;
    });
    var whenSource = histEntry || { whenLabel: whenLabelNow(), reason: "" };
    appendHistHead(
      item,
      histWhenReasonLine(whenSource),
      "st ok",
      fuelingStatusLabel(f.status),
      f.stationName
    );
    if (withDetails) {
      var addr =
        f.stationAddress ||
        (state.stationDetail && state.stationDetail.address) ||
        (histEntry && histEntry.stationAddress) ||
        "";
      if (addr) item.appendChild(el("div", "muted sm", addr));
      var fuelPump = histFuelPumpLine({
        fuelName: f.fuelName || (histEntry && histEntry.fuelName) || "",
        pumpLabel: historyPumpLabel(f),
        pump: f.pump
      });
      if (fuelPump) item.appendChild(el("div", "muted sm", fuelPump));
    }
    item.appendChild(
      el(
        "div",
        "muted",
        "В холде " +
          money(f.amountHeld) +
          (f.liters != null ? " · " + litersStr(f.liters) + " л" : "")
      )
    );
    if ("fueling" === f.status && f.currentLiters != null) {
      item.appendChild(
        el("div", "muted sm", "Налито " + litersStr(f.currentLiters) + " л")
      );
    }
    var open = el("button", "btn secondary hist-open", "К заправке");
    open.type = "button";
    open.onclick = function () {
      openFuelingById(f.id);
    };
    item.appendChild(open);
    return item;
  }

  function histStatusLabel(h) {
    if (h.active) return "Холд активен";
    if (isUnderfillHistory(h)) return "Недолив";
    if (h.ok) return "Успешно";
    if (h.holdReturned) return "Возвращён";
    return "Не удалось";
  }

  function histStatusClass(h) {
    if (h.active) return "st ok";
    if (isUnderfillHistory(h)) return "st underfill";
    if (h.ok) return "st ok";
    return "st bad";
  }

  function histRow(h, withDetails) {
    var showDetails = withDetails !== false;
    if (
      h.active &&
      state.activeFueling &&
      state.activeFueling.id === h.fuelingId
    ) {
      return activeFuelingCard(state.activeFueling, showDetails);
    }
    var item = el("div", "hist-item" + (h.active ? " active-fuel" : ""));
    appendHistHead(
      item,
      histWhenReasonLine(h),
      histStatusClass(h),
      histStatusLabel(h),
      h.stationName
    );
    if (showDetails) {
      if (h.stationAddress) {
        item.appendChild(el("div", "muted sm", h.stationAddress));
      }
      var fuelPump = histFuelPumpLine(h);
      if (fuelPump) item.appendChild(el("div", "muted sm", fuelPump));
    }
    if (h.active) {
      item.appendChild(rowMuted("В холде", money(h.amountHeld)));
      if (h.fuelingId) {
        var open = el("button", "btn secondary hist-open", "К заправке");
        open.type = "button";
        open.onclick = function () {
          openFuelingById(h.fuelingId);
        };
        item.appendChild(open);
      }
    } else if (!h.ok && h.holdReturned) {
      appendHistFormulaRow(item, "Холд", h);
    } else if (h.ok && isUnderfillHistory(h)) {
      // На главной — только списание; возврат холда — в полном окне истории.
      appendHistUnderfillRows(item, h, showDetails);
    } else if (h.ok) {
      appendHistFormulaRow(item, "Списано", h);
    }
    return item;
  }

  function viewHistory() {
    var s = el("div", "screen"),
      body = el("div", "screen-body");
    body.appendChild(
      topBack("История заправок", function () {
        setState({ screen: "home" });
      })
    );
    body.appendChild(
      el(
        "div",
        "hint",
        "Чеков в приложении нет — при необходимости попросите у диспетчера"
      )
    );
    var hist = el("div", "hist");
    if (state.history.length) {
      state.history.forEach(function (h) {
        hist.appendChild(histRow(h));
      });
    } else {
      hist.appendChild(el("div", "hist-item muted", "История пуста"));
    }
    body.appendChild(hist);
    body.appendChild(
      el("div", "muted sm", "История на устройстве (API списка не отдаёт).")
    );
    s.appendChild(body);
    return s;
  }

  function tierTag(item) {
    if ("deal" === item.tier) return el("span", "pill-tag deal", "★ Выгодно");
    if ("cheap" === item.tier) return el("span", "pill-tag deal", "Выгодно");
    if ("mid" === item.tier) return el("span", "pill-tag mid", "Средняя");
    return el("span", "pill-tag dear", "Дорого");
  }

  // Цвет левой полоски по цене (как у обычных карточек АЗС).
  function stripeClass(tier) {
    if ("deal" === tier || "cheap" === tier) return "cheap";
    if ("mid" === tier) return "mid";
    return "dear";
  }

  // Ближайшая: оранжевая обводка + полоска по tier, тег без расстояния.
  function nearStationCard(item) {
    var btn = el("button", "near-block station " + stripeClass(item.tier));
    btn.type = "button";
    var top = el("div", "row");
    top.appendChild(el("span", "name", item.st.name));
    top.appendChild(el("span", "pill-tag near-tag", "Ближайшая"));
    btn.appendChild(top);
    btn.appendChild(el("div", "muted addr", item.st.address || ""));
    var meta = el("div", "meta");
    meta.appendChild(el("span", "dist", formatDist(item.dist)));
    meta.appendChild(stationPriceCol(item));
    btn.appendChild(meta);
    btn.disabled = !!state.loading;
    if (!state.loading) {
      btn.onclick = function () {
        selectStation(item, false);
      };
    }
    return btn;
  }
})();
