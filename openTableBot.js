// ==UserScript==
// @name         OpenTableBot
// @match        https://www.opentable.com/*
// @match        https://cdn.otstatic.com/maintenance/busy/index.html
// @version      0.1
// @description  get your reservation when others cancel
// @author       Nohren
// @grant        window.close
// @grant        GM.setValue
// @grant        GM.getValue
// @grant        GM.xmlHttpRequest
// @connect      localhost
// @run-at       document-end
// ==/UserScript==

(function () {
  "use strict";

  const minCheckTime = 45000;
  const maxCheckTime = 60000 * 2;
  const targetStartTime = "5:15 PM";
  const targetEndTime = "6:00 PM";
  const autoBook = false;
  const ignoreSeatingWords = ["outdoor"];
  const rejectedSlotTimeout = 60 * 60 * 1000; // 1 hour

  function parseTimeToMinutes(timeStr) {
    const match = timeStr.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!match) {
      console.warn(`Could not parse time: "${timeStr}"`);
      return NaN;
    }
    let [, hours, minutes, period] = match;
    hours = parseInt(hours, 10);
    minutes = parseInt(minutes, 10);
    if (period.toUpperCase() === "PM" && hours !== 12) hours += 12;
    if (period.toUpperCase() === "AM" && hours === 12) hours = 0;
    return hours * 60 + minutes;
  }

  function isTimeInWindow(timeStr) {
    const slot = parseTimeToMinutes(timeStr);
    if (isNaN(slot)) return false;
    const start = parseTimeToMinutes(targetStartTime);
    const end = parseTimeToMinutes(targetEndTime);
    return slot >= start && slot <= end;
  }

  function sendEmail(message, href) {
    return new Promise((resolve, reject) => {
      GM.xmlHttpRequest({
        method: "POST",
        url: "http://localhost:8080/reservation",
        headers: {
          "Content-Type": "application/json",
        },
        data: JSON.stringify({ message, href }),
        onload: function (response) {
          if (response.status >= 200 && response.status < 300) {
            console.log("Email send success!");
            console.log(JSON.parse(response.responseText));
            resolve();
          } else {
            console.log("Email send failed", response.status);
            resolve();
          }
        },
        onerror: function (e) {
          console.log("Failed to send data to server", e);
          reject(e);
        },
      });
    });
  }

   function minAndSec(ms) {
     const val = ms / 1000 / 60
     const min = Math.floor(val)
     const sec = Math.round((val - min) * 60)
     return `${min} min and ${sec} seconds`
  }

  function waitForElement(selector, timeout = 15000, interval = 500) {
    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        const el = document.querySelector(selector);
        if (el) return resolve(el);
        if (Date.now() - start > timeout) return resolve(null);
        setTimeout(check, interval);
      };
      check();
    });
  }

  function startCheckingAgain() {
    const randomInterval = randomIntervalFunc();
    console.log(
      `checking again in ${minAndSec(randomInterval)}`
    );
    setTimeout(() => window.location.reload(), randomInterval);
  }

  function randomIntervalFunc() {
    return Math.floor(Math.max(minCheckTime, Math.random() * maxCheckTime));
  }

  //results are within 2.5 hrs of reservation
  async function checkForTimeSlots() {
    console.log("checking for time slots");
    let result;

    // Load and filter expired rejected slots
    const now = Date.now();
    let rejectedSlots = JSON.parse(await GM.getValue("rejectedSlots", "[]"));
    rejectedSlots = rejectedSlots.filter((s) => s.expiry > now);
    await GM.setValue("rejectedSlots", JSON.stringify(rejectedSlots));
    const rejectedTimes = rejectedSlots.map((s) => s.time);
    if (rejectedTimes.length) console.log("Rejected slots:", rejectedTimes.join(", "));

    const slots = await waitForElement("[data-test='time-slots']");
    if (!slots) console.log("time-slots element not found after waiting");
    for (const child of slots?.children ?? []) {
      if (child.firstChild.ariaLabel) {
        const slotTime = child.firstChild.innerText.trim();

        if (!isTimeInWindow(slotTime)) {
          console.log(`Slot at ${slotTime} outside target window (${targetStartTime} - ${targetEndTime}), skipping`);
          continue;
        }

        if (rejectedTimes.includes(slotTime)) {
          console.log(`Slot at ${slotTime} was rejected (bad seating options), skipping`);
          continue;
        }

        result = `Reservation found! - ${new Date()}`;
        await GM.setValue("lastClickedSlot", slotTime);
        await GM.setValue("lastClickedSlotHref", child.firstChild.href);

        //attempt to reserve via bot
        child.firstChild.click();

        break;
      }
    }

    console.log(result ?? `no reservation found - ${new Date()}`);

    // check again in next interval if no result
    if (!result) {
       try {
        startCheckingAgain();
       } catch (error) {
        console.error("Error while restarting the check:", error);
       }
    }
  }

  async function completeReservation() {
    console.log("booking page");

    // Handle "You already have a reservation around this time" modal
    const continueBtn = await waitForElement("[data-test='double-trouble-modal-continue-button']", 5000);
    if (continueBtn) {
      console.log("Double trouble modal detected, clicking Continue");
      continueBtn.click();
    }

    const completeReservationButton = await waitForElement("[data-test='complete-reservation-button']");
    if (!completeReservationButton) {
      console.log("complete-reservation-button not found after waiting");
      return;
    }

    // Reaching this page means time + seating were valid — clear rejected slots
    await GM.setValue("rejectedSlots", "[]");

    const slotTime = await GM.getValue("lastClickedSlot", "unknown");
    const slotHref = await GM.getValue("lastClickedSlotHref", window.location.href);
    const message = `Reservation available at ${slotTime}`;
    await sendEmail(message, slotHref);

    if (!autoBook) {
      console.log("autoBook is disabled, not clicking complete reservation");
      return;
    }

    console.log("Clicking complete reservation button");
    completeReservationButton.click();
  }

  async function handleSeatingOptions() {
    console.log("seating options page");

    // Handle "You already have a reservation around this time" modal
    const continueBtn = await waitForElement("[data-test='double-trouble-modal-continue-button']", 5000);
    if (continueBtn) {
      console.log("Double trouble modal detected, clicking Continue");
      continueBtn.click();
    }

    const firstBtn = await waitForElement('[data-test*="seatingOption"][data-test$="-button"]');
    if (!firstBtn) {
      console.log("No seating option buttons found after waiting");
      startCheckingAgain();
      return;
    }

    const allButtons = document.querySelectorAll('[data-test*="seatingOption"][data-test$="-button"]');
    console.log(`Found ${allButtons.length} seating option(s)`);

    let selectedButton = null;
    for (const btn of allButtons) {
      const testAttr = btn.getAttribute("data-test").toLowerCase();
      const isIgnored = ignoreSeatingWords.some((word) => testAttr.includes(word.toLowerCase()));
      if (isIgnored) {
        console.log(`Ignoring seating option: ${testAttr}`);
        continue;
      }
      console.log(`Selecting seating option: ${testAttr}`);
      selectedButton = btn;
      break;
    }

    if (selectedButton) {
      selectedButton.click();
      // Clicking the seating option does a client-side (SPA) navigation,
      // so Tampermonkey won't re-run the script. Poll for the URL change
      // and call completeReservation directly.
      const pollForBookingPage = setInterval(() => {
        if (window.location.pathname === "/booking/details") {
          clearInterval(pollForBookingPage);
          completeReservation();
        }
      }, 300);
      // Stop polling after 15s as a safety net
      setTimeout(() => clearInterval(pollForBookingPage), 15000);
    } else {
      // All options matched ignore list — reject this slot
      const slotTime = await GM.getValue("lastClickedSlot", null);
      console.log(`All seating options ignored for slot ${slotTime}, rejecting`);
      if (slotTime) {
        const rejectedSlots = JSON.parse(await GM.getValue("rejectedSlots", "[]"));
        rejectedSlots.push({ time: slotTime, expiry: Date.now() + rejectedSlotTimeout });
        await GM.setValue("rejectedSlots", JSON.stringify(rejectedSlots));
      }
      const url = await GM.getValue("url", null);
      if (url) {
        console.log(`Navigating back to restaurant page: ${url}`);
        window.location.assign(url);
      } else {
        console.log("No restaurant URL saved, reloading");
        window.history.back();
      }
    }
  }

  async function kickedOut(wait) {
    const url = await GM.getValue("url", null);
    if (!url) {
        console.log(`no url to back to ${url}`);
        await sendEmail('Got kicked out, no url to go back to!', window.location.href)
        return
    }
    console.log(`got kicked out. Will try again in ${minAndSec(wait)}`)
    console.log(url)
    setTimeout(() => {
      window.location.assign(url)
    }, wait ?? 1000 * 60 * 5)
  }

  function execute(func) {
    //somtimes user script is injected after the page is loaded, and sometimes before.
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", func);
    } else {
      func();
    }
  }

  const el = document.createElement("div");
  el.style.position = "relative";
  el.style.textAlign = "center";
  el.style.fontWeight = "bold";
  el.style.fontSize = "xx-large";
  el.innerText = `🤖 Agent Running (${targetStartTime} - ${targetEndTime})`;
  el.style.backgroundColor = "lime";

  switch (true) {
      case /\/r\/[a-zA-Z0-9-]+/.test(window.location.pathname) || !!document.querySelector("[data-testid='restaurant-banner-content-container']"):
          GM.setValue("url", window.location.href);
          console.log(`set url as ${window.location.href}`)
          execute(checkForTimeSlots)
          break
      case window.location.pathname === "/maintenance/busy/index.html":
          console.log('kicked out');
          execute(kickedOut)
          break
      case window.location.pathname === "/booking/seating-options":
          execute(handleSeatingOptions)
          break
      case window.location.pathname === "/booking/details":
          execute(completeReservation)
          break
      default:
        console.log('default case');
        el.innerText = "🤖 Armed";
        el.style.backgroundColor = "yellow";
  }

  document.body.prepend(el);
})();
