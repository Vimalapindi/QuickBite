"""
Browser-level smoke test (Playwright). Drives the REAL UI against a running stack:
  customer logs in -> searches -> adds to cart -> places an order -> an owner in a SECOND browser context accepts it
  -> the customer's tracker must update live (no reload) -> partner delivers -> customer sees Delivered.
Usage:  pip install playwright && playwright install chromium
        python tools/ui_smoke.py            (APP_URL defaults to http://localhost:5173)
Requires seeded demo data and the API + worker running.
"""
import os, sys, re
from playwright.sync_api import sync_playwright, expect

APP = os.environ.get("APP_URL", "http://localhost:5173")
PW = "Password123!"

def login(page, email, password=PW):
    page.goto(f"{APP}/login")
    page.get_by_label("Email").fill(email)
    page.get_by_label("Password").fill(password)
    page.get_by_role("button", name="Log in").click()

def step(msg): print(f"  ok  {msg}")

with sync_playwright() as p:
    exe = os.environ.get("CHROMIUM_PATH")
    browser = p.chromium.launch(executable_path=exe) if exe else p.chromium.launch()
    cust_ctx, owner_ctx, partner_ctx = (browser.new_context() for _ in range(3))
    cust, owner, partner = cust_ctx.new_page(), owner_ctx.new_page(), partner_ctx.new_page()
    errors = []
    for pg in (cust, owner, partner):
        pg.on("pageerror", lambda e: errors.append(str(e)))

    login(cust, "customer1@quickbite.dev")
    expect(cust.get_by_role("heading", name="What are you craving?")).to_be_visible(); step("customer logged in, sees restaurant search")

    cust.get_by_placeholder("Search biryani, pizza, a restaurant…").fill("Spice Route")
    cust.get_by_role("link", name=re.compile("Spice Route Biryani")).first.click()
    expect(cust.get_by_role("heading", name="Spice Route Biryani")).to_be_visible(); step("search found the restaurant; menu opened")

    cust.get_by_role("button", name="Add", exact=True).first.click()
    expect(cust.get_by_text(re.compile(r"1 item"))).to_be_visible(); step("added a dish; cart bar shows 1 item")
    cust.get_by_role("link", name="Review cart").click()
    cust.get_by_role("button", name=re.compile("Place order")).click()
    cust.wait_for_url(re.compile(r"/orders/[0-9a-f-]{36}")); step("order placed, redirected to tracking page")
    expect(cust.get_by_text("live updates on")).to_be_visible(timeout=5000); step("customer socket joined the order room")
    expect(cust.get_by_role("heading", name="Spice Route Biryani")).to_be_visible()
    expect(cust.locator(".pill").first).to_have_text(re.compile("paid"), timeout=8000); step("payment worker ran asynchronously: status moved to PAID live")

    login(owner, "owner1@quickbite.dev")
    owner.wait_for_url(f"{APP}/owner")
    owner.get_by_role("button", name="Accept").first.click(timeout=8000); step("owner saw the new paid order and clicked Accept")
    expect(cust.locator(".pill").first).to_have_text(re.compile("confirmed"), timeout=8000); step("customer tracker updated to CONFIRMED with NO page reload")
    for label, status in (("Mark preparing", "preparing"), ("Mark ready for pickup", "ready for pickup")):
        owner.get_by_role("button", name=label).first.click()
        expect(cust.locator(".pill").first).to_have_text(re.compile(status), timeout=8000)
    step("owner advanced PREPARING -> READY; customer saw each step live")

    login(partner, "partner1@quickbite.dev")
    partner.wait_for_url(f"{APP}/partner")
    if partner.get_by_role("button", name="Go online").count():
        partner.get_by_role("button", name="Go online").click()
    expect(partner.get_by_role("button", name="Picked up")).to_be_visible(timeout=15000); step("partner auto-assigned the order")
    partner.get_by_role("button", name="Picked up").click()
    expect(cust.locator(".pill").first).to_have_text(re.compile("picked up"), timeout=8000)
    partner.get_by_role("button", name="Delivered").click()
    expect(cust.locator(".pill").first).to_have_text(re.compile("delivered"), timeout=8000); step("partner picked up and delivered; customer saw DELIVERED live")

    cust.get_by_role("button", name=re.compile("Notifications")).click()
    expect(cust.get_by_text("Delivered", exact=True).first).to_be_visible(); step("notification bell lists the delivery notification")
    cust.screenshot(path=os.environ.get("SHOT", "/tmp/tracking.png"), full_page=True)
    browser.close()
    if errors:
        print("JS errors:", errors); sys.exit(1)
print("UI SMOKE TEST PASSED")
