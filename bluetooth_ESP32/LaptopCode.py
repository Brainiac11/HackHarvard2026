import asyncio
from bleak import BleakScanner, BleakClient

COMMAND_UUID = "12345678-1234-1234-1234-123456789001"

async def main():
    device = await BleakScanner.find_device_by_name(
        "ESPcmd", timeout=15
    )

    if device is None:
        print("ESP32 not found.")
        return

    async with BleakClient(device) as client:
        print("Connected. Enter a command, or 'quit'.")

        while True:
            command = await asyncio.to_thread(input, "> ")

            if command.lower() == "quit":
                break

            data = command.encode("utf-8")

            if not 1 <= len(data) <= 20:
                print("Use 1–20 bytes per command.")
                continue

            await client.write_gatt_char(
                COMMAND_UUID, data, response=True
            )

asyncio.run(main())