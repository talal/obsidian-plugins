from .server import start_server

# Start the server when the addon is loaded by Anki
_server_instance = start_server()
