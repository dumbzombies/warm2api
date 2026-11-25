import json
users = json.load(open("data.json"))["users"]
for u in users:
    print(u["name"], u["age"])
