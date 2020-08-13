FROM node:latest
RUN mkdir -p /usr/src/app
WORKDIR '/usr/src/app'
COPY . /usr/src/app
RUN npm install
EXPOSE 32464
CMD ['npm', 'start']
#These are the commands for the Dockerfile