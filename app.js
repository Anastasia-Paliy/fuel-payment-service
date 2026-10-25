/**
 * Заправка в рейсе — прототип водительского UI (pure JS + FakeApi).
 * Экраны: home → fuel → stations → pump → volume → confirm → process → result.
 * История и pending-заказ хранятся в localStorage.
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
        netScreen: null
      },
      root = document.getElementById("app");
    (window.addEventListener("online", function () {
      ((state.online = true),
        "home" === state.screen
          ? refreshHome()
          : "process" === state.screen && state.fueling
            ? startPolling(state.fueling.id)
            : render());
    }),
      window.addEventListener("offline", function () {
        ((state.online = false), render());
      }),
      (window.App = {
        state: state,
        boot: boot,
        goHome: goHome,
        pushHistory: pushHistory,
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
    if (changed) clearTripLocalData();
    cacheTrip(trip);
    return changed;
  }

  function pushHistory(entry) {
    var list = state.history.slice();
    (list.unshift(entry),
      list.length > 30 && (list = list.slice(0, 30)),
      (state.history = list),
      saveJson("zapravka.history.v1", list));
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
          setState({
            loading: false,
            screen: "home",
            trip: tripInfo.trip,
            tripFromCache: !!tripInfo.fromCache,
            online: !tripInfo.fromCache,
            error: tripInfo.err || null,
            activeFueling: active,
            overlay: active ? "active" : null
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
    (setState({
      loading: true,
      error: null
    }),
      callApi("getTrip")
        .then(function (trip) {
          var changed = applyTrip(trip);
          return callApi("getActiveFueling").then(function (active) {
            if (changed) active = null;
            setState({
              loading: false,
              trip: trip,
              tripFromCache: false,
              online: true,
              activeFueling: active,
              overlay: active ? "active" : null,
              error: null
            });
          });
        })
        .catch(function (err) {
          setState({
            loading: false,
            error: err,
            online: false
          });
        }));
  }

  function goHome() {
    (stopPoll(),
      setState({
        screen: "home",
        overlay: null,
        sheet: null,
        netScreen: null,
        sending: false,
        fueling: null,
        stationDetail: null
      }),
      refreshHome());
  }

  function onStartFueling() {
    if (!state.online || state.tripFromCache) return;
    if (state.activeFueling) {
      setState({ overlay: "active" });
      return;
    }
    // Перед заказом подтягиваем свежий лимит рейса (как «Обновить»).
    setState({ loading: true, error: null });
    callApi("getTrip")
      .then(function (trip) {
        applyTrip(trip);
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
    var f = state.activeFueling;
    f &&
      (setState({
        overlay: null,
        fueling: f,
        screen: "process",
        lastFueling: null
      }),
      startPolling(f.id));
  }

  /* ========== stations: load, enrich, select ========== */
  function loadStations() {
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
    (setState({
      loading: true,
      selectedStationId: stationId,
      fuelCode: fuelCode,
      price: price,
      selectedPump: null
    }),
      callApi("getStation", [stationId])
        .then(function (detail) {
          var fuel = null;
          (detail.fuels.forEach(function (f) {
            f.code === fuelCode && (fuel = f);
          }),
            setState({
              loading: false,
              stationDetail: detail,
              fuelName: fuel ? fuel.name : fuelCode,
              price: fuel ? fuel.price : price,
              litersMin: detail.litersMin,
              litersMax: detail.litersMax,
              screen: "pump",
              sheet: null
            }));
        })
        .catch(function (err) {
          setState({
            loading: false,
            error: err,
            netScreen: "stations",
            screen: "net"
          });
        }));
  }

  /* ========== volume / soft budget (50% of trip total 20000) ========== */
  function hardMaxLiters() {
    var price = Number(state.price) || 1,
      byMoney = Math.floor((Number(state.trip && state.trip.limitLeft) || 0) / price);
    return Math.max(state.litersMin, Math.min(state.litersMax, byMoney));
  }

  function budgetRub() {
    return Math.round(0.5 * 2e4);
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
  function submitFueling() {
    if (!state.sending) {
      var payload = buildStartPayload();
      (savePending({
        clientRequestId: payload.clientRequestId,
        payload: payload,
        at: Date.now()
      }),
        setState({
          sending: true,
          screen: "confirm"
        }),
        callApi("startFueling", [payload])
          .then(function (f) {
            (savePending(null),
              setState({
                sending: false,
                fueling: f,
                activeFueling: f,
                screen: "process",
                online: true
              }),
              startPolling(f.id));
          })
          .catch(function (err) {
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
                    clientRequestId: null
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
              (setState({
                sending: false,
                sheet: "error",
                sheetData: err,
                clientRequestId: null
              }),
                savePending(null));
            } else
              setState({
                sending: false,
                netScreen: "afterStart",
                screen: "net"
              });
          }));
    }
  }

  function retrySameOrder() {
    var p = state.pending && state.pending.payload;
    (p || (p = buildStartPayload()),
      setState({
        sending: true,
        screen: "confirm",
        netScreen: null
      }),
      callApi("startFueling", [p])
        .then(function (f) {
          (savePending(null),
            setState({
              sending: false,
              fueling: f,
              activeFueling: f,
              screen: "process"
            }),
            startPolling(f.id));
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
        }));
  }

  function checkActiveAfterNet() {
    (setState({
      loading: true
    }),
      callApi("getActiveFueling")
        .then(function (f) {
          f
            ? (savePending(null),
              setState({
                loading: false,
                fueling: f,
                activeFueling: f,
                screen: "process",
                netScreen: null
              }),
              startPolling(f.id))
            : setState({
                loading: false,
                netScreen: "beforeStart",
                screen: "net"
              });
        })
        .catch(function () {
          setState({
            loading: false,
            netScreen: "status",
            screen: "net"
          });
        }));
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

  // Итог заправки: одна запись в историю на id (cancel + poll иначе дублируют).
  function finishFueling(f) {
    stopPoll();
    var alreadyDone =
      state.lastFueling &&
      state.lastFueling.id === f.id &&
      ("completed" === state.lastFueling.status || "cancelled" === state.lastFueling.status);
    if (!alreadyDone) {
      var d = new Date();
      var months = [
        "янв",
        "фев",
        "мар",
        "апр",
        "май",
        "июн",
        "июл",
        "авг",
        "сен",
        "окт",
        "ноя",
        "дек"
      ];
      var ok = "completed" === f.status;
      pushHistory({
        ok: ok,
        holdReturned: !ok,
        stationName: f.stationName,
        factLiters: f.factLiters,
        factAmount: f.factAmount,
        reason: reasonLabel(f.reason),
        whenLabel:
          d.getDate() +
          " " +
          months[d.getMonth()] +
          ", " +
          String(d.getHours()).padStart(2, "0") +
          ":" +
          String(d.getMinutes()).padStart(2, "0"),
        fuelingId: f.id
      });
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
        applyTrip(trip);
        setState({
          trip: trip,
          tripFromCache: false
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
                ? (function () {
                    var s = el("div", "screen"),
                      body = el("div", "screen-body");
                    body.appendChild(
                      topBack("История заправок", function () {
                        setState({
                          screen: "home"
                        });
                      })
                    );
                    var hist = el("div", "hist");
                    state.history.length
                      ? state.history.forEach(function (h) {
                          var item = histRow(h);
                          (item.appendChild(
                            rowMuted(
                              h.ok ? "Списано" : "Холд",
                              h.ok ? money(h.factAmount) : "возвращён"
                            )
                          ),
                            hist.appendChild(item));
                        })
                      : hist.appendChild(el("div", "hist-item muted", "История пуста"));
                    return (
                      body.appendChild(hist),
                      body.appendChild(
                        el("div", "muted sm", "*История на устройстве")
                      ),
                      s.appendChild(body),
                      s
                    );
                  })()
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
                          "hint neutral",
                          "Один тип топлива на заказ. Точное название на АЗС может отличаться (например, «ДТ ЭКО», «Дизель»)."
                        )
                      );
                      s.appendChild(body);
                      var bottom = el("div", "bottom"),
                        next = el("button", "btn", "К выбору АЗС");
                      return (
                        (next.type = "button"),
                        (next.onclick = loadStations),
                        bottom.appendChild(next),
                        s.appendChild(bottom),
                        s
                      );
                    })()
                  : "stations" === state.screen
                    ? (function () {
                        var s = el("div", "screen");
                        state.online || s.appendChild(el("div", "banner bad", "Нет связи"));
                        var body = el("div", "screen-body");
                        ((body.style.display = "flex"),
                          (body.style.flexDirection = "column"),
                          (body.style.minHeight = "0"),
                          body.appendChild(
                            topBack("Выбор АЗС", function () {
                              setState({
                                screen: "fuel"
                              });
                            })
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
                                      var cls =
                                          "station " +
                                          ("deal" === item.tier || "cheap" === item.tier
                                            ? "cheap"
                                            : "mid" === item.tier
                                              ? "mid"
                                              : "dear"),
                                        btn = el("button", cls);
                                      btn.type = "button";
                                      var top = el("div", "row");
                                      (top.appendChild(el("span", "name", item.st.name)),
                                        top.appendChild(tierTag(item)),
                                        btn.appendChild(top));
                                      var meta = el("div", "meta");
                                      meta.appendChild(
                                        el("span", "dist", formatDist(item.dist))
                                      );
                                      var pr = el("span", "price", perLiter(item.price));
                                      "dear" === item.tier && (pr.style.color = "var(--dear)");
                                      ("deal" !== item.tier && "cheap" !== item.tier) ||
                                        (pr.style.color = "var(--cheap)");
                                      "mid" === item.tier && (pr.style.color = "var(--mid)");
                                      return (
                                        meta.appendChild(pr),
                                        btn.appendChild(meta),
                                        btn.appendChild(
                                          el("div", "muted", item.st.address || "")
                                        ),
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
                        return (body.appendChild(scroll), s.appendChild(body), s);
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
                                  "У «Колесо» на стойках буквы: А = 1, Б = 2, В = 3…"
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
                              topBack("Сколько лить", function () {
                                setState({
                                  screen: "pump"
                                });
                              })
                            ),
                              body.appendChild(stepsBar(3)));
                            var d = state.stationDetail,
                              card = el("div", "card");
                            (card.appendChild(
                              el(
                                "div",
                                "muted",
                                (d ? d.name : "") +
                                  " · " +
                                  pumpLabel(d && d.brand, state.selectedPump) +
                                  " · " +
                                  (state.fuelName || "")
                              )
                            ),
                              card.appendChild(rowMuted("Цена", perLiter(state.price))),
                              card.appendChild(
                                rowMuted(
                                  "Лимит АЗС на одну заправку",
                                  "до " + state.litersMax + " л"
                                )
                              ),
                              card.appendChild(
                                rowMuted("Доступно", money(state.trip && state.trip.limitLeft))
                              ),
                              body.appendChild(card));
                            var vol = clampVolume(state.volume),
                              maxH = hardMaxLiters(),
                              rec = recommendedLiters(),
                              sum = Math.round(vol * state.price * 100) / 100,
                              atCardLimit = vol >= state.litersMax && state.litersMax <= maxH,
                              atMoneyLimit = vol >= maxH && maxH < state.litersMax,
                              canPlus10 = vol + 10 <= maxH,
                              canPlus50 = vol + 50 <= maxH,
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
                              (p10.disabled = !canPlus10),
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
                              (p50.disabled = !canPlus50),
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
                              body.appendChild(recRow),
                              atCardLimit
                                ? body.appendChild(
                                    el(
                                      "div",
                                      "hint",
                                      "Лимит на одну заправку — " +
                                        state.litersMax +
                                        " литров. Нужно больше? Оформите ещё один заказ."
                                    )
                                  )
                                : atMoneyLimit &&
                                  body.appendChild(
                                    el(
                                      "div",
                                      "hint",
                                      "Больше нельзя: доступно " +
                                        money(state.trip.limitLeft) +
                                        "."
                                    )
                                  ));
                            sum > budgetRub() + 0.01 &&
                              body.appendChild(
                                el(
                                  "div",
                                  "tip-save",
                                  "Выгоднее оставить запас на рейс. При сбое холд может вернуться не сразу."
                                )
                              );
                            s.appendChild(body);
                            var bottom = el("div", "bottom"),
                              next = el("button", "btn", "К подтверждению · " + vol + " л");
                            return (
                              (next.type = "button"),
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
                                topBack("Проверьте заказ", function () {
                                  state.sending ||
                                    setState({
                                      screen: "volume"
                                    });
                                })
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
                                body.appendChild(card),
                                body.appendChild(
                                  el(
                                    "div",
                                    "hint",
                                    state.sending
                                      ? "Отправляем заказ… Не нажимайте снова."
                                      : "Нажмите один раз. Кнопка сразу станет недоступной."
                                  )
                                ),
                                s.appendChild(body));
                              var bottom = el("div", "bottom"),
                                go = el(
                                  "button",
                                  "btn" + (state.sending ? " sending" : ""),
                                  state.sending
                                    ? "Отправляем…"
                                    : "Заправить · " +
                                        money(
                                          Math.round(state.volume * state.price * 100) / 100
                                        )
                                );
                              ((go.type = "button"),
                                state.sending || (go.onclick = submitFueling));
                              if ((bottom.appendChild(go), !state.sending)) {
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
                                state.online
                                  ? false === navigator.onLine &&
                                    s.appendChild(el("div", "banner warn", "Связь слабая"))
                                  : s.appendChild(
                                      el(
                                        "div",
                                        "banner bad",
                                        "Нет связи · налив на АЗС продолжается, цифры догонят"
                                      )
                                    );
                                var body = el("div", "screen-body");
                                if ((body.appendChild(stepsBar(4)), !f))
                                  return (
                                    body.appendChild(el("div", "muted", "Нет данных заправки")),
                                    s.appendChild(body),
                                    s
                                  );
                                var center = el("div", "center");
                                if ("accepted" === f.status || "waiting_nozzle" === f.status) {
                                  (center.appendChild(
                                    (((wrap = el("div", "nozzle")).innerHTML =
                                      '<svg viewBox="0 0 140 140" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="18" y="28" width="52" height="88" rx="10" fill="#FFF0E6" stroke="#FF6200" stroke-width="4"/><rect x="28" y="40" width="32" height="20" rx="4" fill="#FF6200"/><path d="M70 48h22c8 0 14 6 14 14v18" stroke="#111" stroke-width="6" stroke-linecap="round"/><path d="M106 80c10 0 16 8 16 18v10" stroke="#111" stroke-width="6" stroke-linecap="round"/><rect x="112" y="106" width="18" height="28" rx="5" fill="#111"/><path d="M44 78v28" stroke="#FF6200" stroke-width="5" stroke-linecap="round"/><circle cx="44" cy="70" r="5" fill="#FF6200"/></svg>'),
                                    wrap)
                                  ),
                                    center.appendChild(el("div", "big", "Вставьте пистолет")));
                                  var elapsed =
                                      (Date.now() - (f.createdAt || Date.now())) / 1e3,
                                    left = Math.max(0, Math.ceil(60 - elapsed));
                                  if (state.online) {
                                    var mm = String(Math.floor(left / 60)),
                                      ss = String(left % 60);
                                    (ss.length < 2 && (ss = "0" + ss),
                                      center.appendChild(el("div", "timer", mm + ":" + ss)),
                                      center.appendChild(
                                        el("div", "timer-label", "до возможной отмены заказа")
                                      ));
                                  } else
                                    (center.appendChild(el("div", "timer", "—:—")),
                                      center.appendChild(
                                        el("div", "timer-label", "таймер обновим при сети")
                                      ));
                                  var card = el("div", "card");
                                  ((card.style.width = "100%"),
                                    card.appendChild(
                                      rowMuted(
                                        "Колонка",
                                        pumpLabel(
                                          state.stationDetail && state.stationDetail.brand,
                                          f.pump
                                        )
                                      )
                                    ),
                                    card.appendChild(rowMuted("В холде", money(f.amountHeld))),
                                    center.appendChild(card));
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
                                  ((fi.style.width = pct + "%"),
                                    prog.appendChild(fi),
                                    center.appendChild(prog));
                                  var card2 = el("div", "card");
                                  ((card2.style.width = "100%"),
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
                                        "Отменить нельзя. Новый заказ не создавайте."
                                      )
                                    ));
                                }
                                var wrap;
                                (body.appendChild(center), s.appendChild(body));
                                var bottom = el("div", "bottom");
                                if ("accepted" === f.status || "waiting_nozzle" === f.status) {
                                  var cancel = el(
                                    "button",
                                    "btn danger",
                                    state.online ? "Отменить заказ" : "Отменить · нет сети"
                                  );
                                  if (
                                    ((cancel.type = "button"),
                                    (cancel.disabled = !state.online || state.sending),
                                    (cancel.onclick = cancelFueling),
                                    bottom.appendChild(cancel),
                                    !state.online)
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
                                  ((card.style.width = "100%"),
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
                                          "Чек утром у диспетчера — в приложении его нет"
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
                                              "Заказ мог уже уйти на АЗС. Не создавайте новый — будет второй холд."))
                                          : "status" === kind
                                            ? ((title = "Статус не обновился"),
                                              (text =
                                                "Проверьте позже. Новый заказ не оформляйте."))
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
                                      ((card.style.width = "100%"),
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
                                    } else if (
                                      "afterStart" === kind ||
                                      "cancel" === kind ||
                                      "status" === kind
                                    ) {
                                      var c = el("button", "btn", "Проверить статус");
                                      if (
                                        ((c.type = "button"),
                                        (c.onclick = checkActiveAfterNet),
                                        bottom.appendChild(c),
                                        "afterStart" === kind || "beforeStart" === kind)
                                      ) {
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
                el("div", "muted", "При заказе сумма временно блокируется на лимите рейса.")
              ),
              sheet.appendChild(
                el(
                  "div",
                  "muted",
                  "После заправки списывается только факт, остаток холда возвращается."
                )
              ),
              sheet.appendChild(
                el("div", "muted", "Если заправка не прошла — холд возвращается.")
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
      "active" === state.overlay &&
        state.activeFueling &&
        root.appendChild(
          (function () {
            var f = state.activeFueling,
              wrap = el("div", "overlay"),
              sheet = el("div", "sheet");
            (sheet.appendChild(el("h3", null, "Есть незавершённая заправка")),
              sheet.appendChild(
                el("div", "muted", "Откройте её — не создавайте новый заказ.")
              ));
            var card = el("div", "card");
            (card.appendChild(rowMuted("АЗС", f.stationName || "—")),
              card.appendChild(
                rowMuted(
                  "Статус",
                  ((st = f.status),
                  {
                    accepted: "принят",
                    waiting_nozzle: "ожидание пистолета",
                    fueling: "налив",
                    completed: "завершена",
                    cancelled: "отменена"
                  }[st] ||
                    st ||
                    "—")
                )
              ),
              card.appendChild(rowMuted("В холде", money(f.amountHeld))),
              sheet.appendChild(card));
            var st;
            var open = el("button", "btn", "Открыть заправку");
            ((open.type = "button"), (open.onclick = openActiveFueling));
            var later = el("button", "btn secondary", "Позже");
            return (
              (later.type = "button"),
              (later.onclick = function () {
                setState({
                  overlay: null
                });
              }),
              sheet.appendChild(open),
              sheet.appendChild(later),
              wrap.appendChild(sheet),
              wrap
            );
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
              var dearRow = el("div", "row");
              dearRow.appendChild(el("span", "lbl-dear", "Выбрано"));
              dearRow.appendChild(el("span", "price-dear", perLiter(data.item.price)));
              cmp.appendChild(dearRow);
              cmp.appendChild(
                el("div", "muted sm", data.item.st.name + " · " + formatDist(data.item.dist))
              );
              if (data.better) {
                var goodRow = el("div", "row");
                goodRow.style.marginTop = "10px";
                goodRow.appendChild(el("span", "lbl-good", "Выгоднее"));
                goodRow.appendChild(el("span", "price-good", perLiter(data.better.price)));
                cmp.appendChild(goodRow);
                cmp.appendChild(
                  el(
                    "div",
                    "muted sm",
                    data.better.st.name + " · " + formatDist(data.better.dist)
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
              var pick = el("button", "btn", "Выбрать колонку");
              ((pick.type = "button"),
                (pick.onclick = function () {
                  (setState({
                    sheet: null,
                    screen: "pump",
                    selectedPump: null
                  }),
                    openStation(state.selectedStationId, state.fuelCode, state.price));
                }),
                sheet.appendChild(pick));
            } else if ("budgetHelp" === kind) {
              (sheet.appendChild(el("h3", null, "Рекомендуемый расход")),
                sheet.appendChild(
                  el(
                    "div",
                    "muted",
                    "Бюджет — 50% от исходного лимита рейса (20 000 ₽ → 10 000 ₽)."
                  )
                ),
                sheet.appendChild(
                  el(
                    "div",
                    "muted",
                    "«Рекомендовано» подставляет объём по бюджету, не выше лимита АЗС и доступных денег."
                  )
                ),
                sheet.appendChild(
                  el(
                    "div",
                    "muted",
                    "Выше бюджета можно. Выше доступного или лимита АЗС — нельзя."
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

  function topBack(title, onBack) {
    var bar = el("div", "topbar"),
      b = el("button", "help", "←");
    return (
      (b.type = "button"),
      (b.onclick = onBack),
      bar.appendChild(b),
      bar.appendChild(el("h2", null, title)),
      bar
    );
  }

  function rowMuted(a, b) {
    var r = el("div", "row");
    return (
      (r.style.marginTop = "6px"),
      r.appendChild(el("span", "muted", a)),
      r.appendChild(el("span", null, b)),
      r
    );
  }

  /* ========== home screen ========== */
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
    if ((body.appendChild(el("h1", "title", "Заправка в рейсе")), !state.trip)) {
      (body.appendChild(el("div", "card muted", "Не удалось загрузить рейс.")),
        s.appendChild(body));
      var bf = el("div", "bottom"),
        rb = el("button", "btn secondary", "Обновить");
      return (
        (rb.type = "button"),
        (rb.onclick = refreshHome),
        bf.appendChild(rb),
        s.appendChild(bf),
        s
      );
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
      // Полоска = остаток от 20 000 ₽ (не израсходованное).
      leftPct = Math.max(0, Math.min(100, Math.round((100 * left) / 2e4))),
      cardLimit = el("div", "card");
    (cardLimit.appendChild(
      el("div", "muted", state.tripFromCache ? "Доступно · кэш" : "Доступно сейчас")
    ),
      cardLimit.appendChild(el("div", "limit", money(left))),
      cardLimit.appendChild(el("div", "muted", "из " + money(2e4) + " на рейс")));
    var bar = el("div", "progress"),
      fill = el("i");
    ((fill.style.width = leftPct + "%"),
      bar.appendChild(fill),
      cardLimit.appendChild(bar),
      body.appendChild(cardLimit));
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
      body.appendChild(holdLine),
      body.appendChild(el("div", "section-label", "Последние заправки")));
    var hist = el("div", "hist"),
      preview = state.history.slice(0, 2);
    (preview.length
      ? preview.forEach(function (h) {
          hist.appendChild(histRow(h));
        })
      : hist.appendChild(el("div", "hist-item muted", "Пока пусто — появятся после заказов")),
      body.appendChild(hist));
    var all = el("button", "linkish", "Вся история →");
    ((all.type = "button"),
      (all.onclick = function () {
        setState({
          screen: "history",
          overlay: null
        });
      }),
      body.appendChild(all),
      s.appendChild(body));
    var bottom = el("div", "bottom");
    if (!state.online || state.tripFromCache) {
      var retry = el("button", "btn secondary", "Обновить");
      ((retry.type = "button"), (retry.onclick = refreshHome), bottom.appendChild(retry));
    }
    var go = el("button", "btn", "Заправиться");
    return (
      (go.type = "button"),
      (go.disabled = !state.online || state.tripFromCache),
      (go.onclick = onStartFueling),
      bottom.appendChild(go),
      s.appendChild(bottom),
      s
    );
  }

  /* ========== history row / station tags / nearest card ========== */
  function histRow(h) {
    var item = el("div", "hist-item"),
      top = el("div", "top");
    top.appendChild(el("span", "name", h.stationName || "АЗС"));
    var st = el(
      "span",
      "st " + (h.ok ? "ok" : "bad"),
      h.ok ? "Успешно" : h.holdReturned ? "Холд возвращён" : "Не удалось"
    );
    (top.appendChild(st), item.appendChild(top));
    var line = h.ok
      ? (h.whenLabel || "") + " · " + litersStr(h.factLiters) + " л · " + money(h.factAmount)
      : (h.whenLabel ? h.whenLabel + " · " : "") + (h.reason || "");
    return (item.appendChild(el("div", "muted", line || "—")), item);
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

  function paintPrice(node, tier) {
    if ("dear" === tier) node.style.color = "var(--dear)";
    else if ("mid" === tier) node.style.color = "var(--mid)";
    else node.style.color = "var(--cheap)";
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
    var pr = el("span", "price", perLiter(item.price));
    paintPrice(pr, item.tier);
    meta.appendChild(pr);
    btn.appendChild(meta);
    btn.onclick = function () {
      selectStation(item, false);
    };
    return btn;
  }
})();
